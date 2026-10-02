import { useEffect, useRef, useState } from "react";
import {
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  defaultValueCtx,
  parserCtx,
  serializerCtx,
  rootCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { $prose, callCommand, insert, replaceAll } from "@milkdown/kit/utils";
import { keymap } from "@milkdown/kit/prose/keymap";
import { Plugin, PluginKey, Selection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { placementsByBlock, type AnnotationPlacement } from "./note-annotation-placement";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import * as Y from "yjs";
import { yUndoPlugin, ySyncPlugin, ySyncPluginKey, undoCommand, redoCommand } from "y-prosemirror";
import { applyNoteSource, noteCaretPosition, noteSourceSignature, readNoteSource, NOTE_SOURCE_INPUT_ORIGIN, type NoteDocumentPosition } from "./note-source-bridge";
import {
  paragraphSchema,
  headingSchema,
  codeBlockSchema,
  blockquoteSchema,
  bulletListSchema,
  orderedListSchema,
  imageSchema,
} from "@milkdown/kit/preset/commonmark";
import { sourceImageObjectKeyFromUrl } from "@ailearn/shared/source-image-contracts";
import { loadSourceImageBlobUrl } from "../source/source-image.ts";
import { LightboxViewer } from "../source/image-viewer.tsx";

/**
 * 笔记正文的所见即所得编辑器（Milkdown）。
 *
 * 这里用的是 Web 端笔记编辑器那一套：CommonMark + GFM 的 ProseMirror 文档、
 * `history` 承担撤销栈、`listener` 把整篇 Markdown 交出去，正文本身是**真
 * Markdown**——`#`、`> `、`- `、围栏都由编辑器自己写，不再靠工具按钮往纯文本里
 * 拼标记。保存合同存的仍是分类型的块，换算在 `note-blocks.ts` 里收口。
 *
 * 三个自有插件补上写作时的实际需要：
 * - 图片粘贴/拖拽拦截：剪贴板或拖拽里只要有图片就交给父组件上传，正文里先落一个
 *   占位地址，上传完成后原位换成服务端确认的站内地址；
 * - 代码块内 Tab：插两个空格，而不是把焦点移出编辑器；
 * - 空文档占位符：`data-placeholder` 由 CSS 画出来。
 *
 * 命令式操作（工具栏按钮、图片上传后回填）通过 `ref` 暴露的 handle 完成。Web 端
 * 那套 handle 的形状原样保留，因为它已经在真实使用中定过型。
 */
export type NoteMarkdownEditorHandle = {
  /** 当前整篇 Markdown；编辑器尚未就绪时返回 null。 */
  readonly getMarkdown: () => string | null;
  /** 整体替换。`flush` 为真时同时清掉撤销历史（用于外部同步）。 */
  readonly setMarkdown: (markdown: string, flush?: boolean) => void;
  readonly focus: () => void;
  /** 在光标处插入文本，Markdown 语法会被解析渲染。 */
  readonly insertText: (text: string) => void;
  /** 就地替换图片地址，用于上传完成后把占位地址换成真地址。 */
  readonly replaceImageSrc: (oldSrc: string, newSrc: string) => void;
  readonly toggleStrong: () => void;
  readonly toggleEmphasis: () => void;
  readonly toggleInlineCode: () => void;
  readonly toggleHeading: (level: number) => void;
  readonly toggleBlockquote: () => void;
  readonly toggleBulletList: () => void;
  readonly toggleOrderedList: () => void;
  readonly toggleLink: (href: string) => void;
  readonly insertCodeBlock: () => void;
  readonly insertHr: () => void;
  readonly applySource: (markdown: string) => boolean;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly getPosition: () => NoteDocumentPosition;
  readonly focusPosition: (position: NoteDocumentPosition) => void;
  readonly isComposing: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
};

/**
 * 编辑器要带的那两个属性：证据链住在节点属性上。
 *
 * 不声明的话 `updateYFragment` 会把 fragment 里"我的节点上没有的键"**删掉**
 * （`for (const key in yDomAttrs) if (!(key in pAttrs)) removeAttribute(key)`），
 * 于是别人在编辑器里敲一个字，这一块的来源引用就没了。扩属性的姿势只有
 * preset 自己的 `extendSchema`：在 `.config()` 里改 `nodesCtx` 是空操作
 * （那时 preset 还没把节点推进去），实测过。
 */
const NOTE_DOC_ATTRS = { sourceRef: { default: null }, imageAssetId: { default: null } };
const withNoteDocAttrs = (schemaObject: { extendSchema: (handler: never) => unknown }) =>
  schemaObject.extendSchema(((factory: (ctx: never) => object) => (ctx: never) => {
    const definition = factory(ctx) as { attrs?: Record<string, unknown> };
    return { ...definition, attrs: { ...definition.attrs, ...NOTE_DOC_ATTRS } };
  }) as never);

type Props = {
  /** 正文的共享文档片段。编辑器直接写它，不再持有一份文本拷贝。 */
  readonly fragment: Y.XmlFragment;
  /**
   * 光标进了哪一块（`null` = 离开正文）。交给 awareness，别人那一屏才说得出
   * 「小琳 也在写这一段」——这句话的对端说的是他自己所在的位置，不是本机替他猜的。
   */
  readonly onCaretBlock?: (block: number | null) => void;
  readonly initialMarkdown: string;
  readonly onChange: (markdown: string) => void;
  readonly disabled?: boolean;
  /** 图片粘贴/拖拽回调，上传由父组件负责。 */
  readonly onImagePaste?: (file: File) => void;
  /**
   * 可编辑预览态的批注记号（41 §1.1「已有批注记号保留」/ §1.4「保留记号但不阻断输入」）。
   *
   * 画的是**块边一枚记号**，不是把整句包成可点区域：这一格的首要职责是让人改字，
   * 记号只要说清「这里有一条批注」就够了，把整句变成按钮会抢选区与光标。
   */
  readonly annotationPlacements?: readonly AnnotationPlacement[];
  readonly onOpenAnnotation?: (annotationId: string) => void;
  readonly ref?: React.Ref<NoteMarkdownEditorHandle | null>;
  readonly onReady?: (handle: NoteMarkdownEditorHandle | null) => void;
};

/**
 * Milkdown 在卸载时会异步销毁自己的 context，一个 React ref 可能比它活得久一点。
 * 每个命令式操作都先确认 editor 仍然就绪，并容忍这次竞态。
 */
function withReadyEditor<TEditor extends { readonly status: string }, TResult>(
  editor: TEditor | undefined,
  operation: (readyEditor: TEditor) => TResult,
  fallback: TResult,
): TResult {
  if (!editor || editor.status !== "Created") return fallback;
  try {
    return operation(editor);
  } catch {
    return fallback;
  }
}

/**
 * 图片粘贴/拖拽拦截。
 *
 * 只有整份剪贴板/拖拽内容都是图片时才拦截。图片与文本混在一起（例如从网页复制
 * 一段带图的内容）交回 ProseMirror 走正常粘贴，否则会连文字一起丢掉。
 */
function imageUploadPlugin(onImagePaste: React.RefObject<((file: File) => void) | undefined>) {
  return $prose(() => new Plugin({
    key: new PluginKey("NOTE_IMAGE_UPLOAD"),
    props: {
      handlePaste(_view, event) {
        const items = event.clipboardData?.items;
        if (!items) return false;
        const all = Array.from(items);
        const images = all.filter((item) => item.type.startsWith("image/"));
        if (images.length === 0 || images.length < all.length) return false;
        for (const item of images) {
          const file = item.getAsFile();
          if (!file) continue;
          onImagePaste.current?.(file);
          event.preventDefault();
        }
        return true;
      },
      handleDrop(_view, event) {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const all = Array.from(files);
        const images = all.filter((file) => file.type.startsWith("image/"));
        if (images.length === 0) return false;
        if (images.length === all.length) event.preventDefault();
        for (const file of images) onImagePaste.current?.(file);
        return images.length === all.length;
      },
    },
  }));
}

/**
 * 图片节点视图。
 *
 * 正文里的图有两种地址，`<img>` 都画不出来：
 * - `/api/uploads/{objectKey}` 是站内对象，渲染层的 origin 是 `ailearn-app://`，
 *   这个相对路径会落到应用包内；这里按 objectKey 走共享的字节缓存换成 blob URL。
 * - `uploading:{id}` 是上传中的占位地址，交给 CSS 画成一块虚线格子（见
 *   `hud-surface.css` 的 `img[src^="uploading:"]`）。
 *
 * 节点视图只负责把 src 落成能加载的那个；节点属性本身仍归 ProseMirror 所有，
 * 所以上传完成后只改一次节点属性，DOM 会自己跟上。
 *
 * 点击图片交给 React 侧的灯箱放大（`image-viewer.tsx`，经 ref 回调，与
 * `onImagePaste` 同一个模式）。不拦默认行为：ProseMirror 照常把节点选中，灯箱
 * 关掉后这张图仍处于选中态，按 Delete 即可删除。
 */
function imageNodeViewPlugin(
  onImageZoom: React.RefObject<((src: string, alt: string) => void) | undefined>,
) {
  return $prose(() => new Plugin({
    key: new PluginKey("NOTE_IMAGE_VIEW"),
    props: {
      nodeViews: {
        image: ((initialNode) => {
          const dom = document.createElement("img");
          dom.setAttribute("draggable", "false");
          dom.addEventListener("click", () => {
            // `dom.src` 是解析后的绝对地址（blob: 或外链）；还在取字节的图没有
            // src，点了也不会开出空灯箱。
            if (dom.src) onImageZoom.current?.(dom.src, dom.alt);
          });
          let disposed = false;
          let shown = "";
          let retryTimer: ReturnType<typeof setTimeout> | null = null;

          // 只有真的画得出来的图（blob / 外链）才提示可点；上传占位与取字节失败
          // 的图不提示。
          const markZoomable = (src: string) => {
            dom.classList.toggle("note-image-zoomable", /^(https?:|blob:)/i.test(src));
          };

          const show = (src: string, alt: string, attempt = 0) => {
            dom.alt = alt;
            if (src === shown && attempt === 0) return;
            shown = src;
            dom.removeAttribute("src");
            const objectKey = sourceImageObjectKeyFromUrl(src);
            if (!objectKey) {
              dom.classList.remove("note-image-unavailable");
              if (src) dom.src = src;
              markZoomable(src);
              return;
            }
            void loadSourceImageBlobUrl(objectKey).then((blobUrl) => {
              if (disposed || shown !== src) return;
              if (blobUrl) {
                dom.classList.remove("note-image-unavailable");
                dom.src = blobUrl;
                markZoomable(blobUrl);
                return;
              }
              // 取字节失败多半是瞬时的（API 正在重启、网络抖动）：退避重试。
              // 重试真正重取的前提是失败结果不驻留缓存（见 source-image.ts）。
              dom.classList.add("note-image-unavailable");
              markZoomable("");
              if (attempt >= 2) return;
              if (retryTimer) clearTimeout(retryTimer);
              retryTimer = setTimeout(() => {
                if (!disposed && shown === src) show(src, alt, attempt + 1);
              }, 1200 * (attempt + 1));
            });
          };
          const apply = (node: { readonly attrs: Record<string, unknown> }) => {
            show(String(node.attrs.src ?? ""), String(node.attrs.alt ?? ""));
          };
          apply(initialNode);

          return {
            dom,
            update: (next: { readonly type: { readonly name: string }; readonly attrs: Record<string, unknown> }) => {
              if (next.type.name !== "image") return false;
              apply(next);
              return true;
            },
            ignoreMutation: () => true,
            destroy: () => {
              disposed = true;
              if (retryTimer) clearTimeout(retryTimer);
            },
          };
        }),
      },
    },
  }));
}

/**
 * 光标所在块的监听。用插件的 `view.update`：它在**只变选区**时也跑，而
 * `markdownUpdated` 那种内容回调只会漏掉"点了另一段、一个字没打"这一格——
 * 那一格正是冲突提示最需要出现在的时候。
 *
 * 只在块号真的变了才回调：一次按键会派发多次事务，跟着每次重发 awareness 就是把
 * 广播当心跳用。
 */
function caretBlockPlugin(onCaretBlock: React.RefObject<((block: number | null) => void) | undefined>) {
  return $prose(() => new Plugin({
    key: new PluginKey("NOTE_CARET_BLOCK"),
    view: (view) => {
      let last: number | null | undefined;
      const read = (): void => {
        const $from = view.state.selection.$from;
        const block = view.hasFocus() && view.dom.contentEditable !== "false" && $from.depth > 0 ? $from.index(0) : null;
        if (block === last) return;
        last = block;
        onCaretBlock.current?.(block);
      };
      read();
      view.dom.addEventListener("focusin", read);
      view.dom.addEventListener("focusout", read);
      return {
        update: read,
        // 编辑器关掉就把这一格报成"不在任何块里"：awareness 是本机上传统一替换，
        // 不报的话别人那一屏会一直挂着「也在写这一段」，直到这台机器的连接断掉。
        destroy: () => { view.dom.removeEventListener("focusin", read); view.dom.removeEventListener("focusout", read); onCaretBlock.current?.(null); },
      };
    },
  }));
}

/** 代码块内的 Tab 是缩进，不是焦点跳走。 */
function codeBlockTabPlugin() {
  return $prose(() => keymap({
    Tab: (state, dispatch) => {
      const { $head } = state.selection;
      for (let depth = $head.depth; depth > 0; depth -= 1) {
        if ($head.node(depth).type.name === "code_block") {
          if (dispatch) dispatch(state.tr.insertText("  ", $head.pos));
          return true;
        }
      }
      return false;
    },
  }));
}

/** 空文档的占位提示：只含一个空段落时给节点挂上 CSS class。 */
function placeholderPlugin() {
  return $prose(() => new Plugin({
    key: new PluginKey("NOTE_EDITOR_PLACEHOLDER"),
    props: {
      decorations: (state) => {
        const { doc } = state;
        const empty = doc.childCount === 1
          && doc.firstChild?.type.name === "paragraph"
          && doc.firstChild.content.size === 0;
        if (!empty) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, 2, { class: "note-editor-empty", "data-placeholder": "继续写下结论……" }),
        ]);
      },
    },
  }));
}

/**
 * 可编辑预览态的批注记号（41 §1.1 / §1.4）。
 *
 * 落位放在 **PM StateField** 里而不是模块级变量：装饰是随 state 重算的，
 * 放进 state 意味着「批注集合变了」本身就是一次事务，装饰自动跟上；
 * 放模块变量就得自己想办法让 PM 重算一次，那条路实测起来是「记号不消失」。
 *
 * **块下标 == 顶层 PM 节点下标**，实测确认（`use-note-doc-live-view.ts` 是
 * `pmNodesToNoteBlocks(json.content).map((b, ordinal) => …)`，而
 * `pmNodesToNoteBlocks` 对顶层节点 1:1，不摊平）。所以这里用 `doc.forEach`
 * 顺次记数——**不读**任何节点属性：节点 attrs 里根本没有 ordinal（只有
 * `sourceRef` 与 `imageAssetId`），按属性找会永远找不到。
 *
 * 装饰用 `Decoration.node` 挂在块上，而不是 `Decoration.inline` 包住那几个字：
 * 这一格的首要职责是让人改字，把整句变成可点区域会抢选区与光标；41 §1.1 要的
 * 只是「已有批注记号保留」，说清「这一块有一条批注」就够了。
 */
/**
 * 打开旁页的回调：命令式插件拿不到 React props，经这一个 ref 过去。
 *
 * 它是**模块级单例**、跨换笔记也活着，所以每次渲染都要覆盖回去——否则上一篇的
 * 记号会留在这一篇上，那正是「切到编辑态批注全没了」的另一种形状。
 */
const openNoteAnnotationRef: { current: ((annotationId: string) => void) | undefined } = { current: undefined };
/** 集合进插件 state（见 MilkdownControls 里那次事务），所以这里只是 meta 的名字。 */
const setNoteAnnotationPlacements = new PluginKey<readonly AnnotationPlacement[]>("NOTE_EDITOR_ANNOTATION_SET");
/** 集合进插件 state（见 MilkdownControls 里那次事务），`decorations` 经 `this` 读它。 */
const ANNOTATION_PLUGIN = new PluginKey<readonly AnnotationPlacement[]>("NOTE_EDITOR_ANNOTATIONS");
/**
 * 可编辑预览态的批注记号（41 §1.1「已有批注记号保留」/ §1.4「保留记号但不阻断输入」）。
 *
 * **块下标 == 顶层 PM 节点下标**，实测确认（`use-note-doc-live-view.ts` 是
 * `pmNodesToNoteBlocks(json.content).map((b, ordinal) => …)`，而
 * `pmNodesToNoteBlocks` 对顶层节点 1:1，不摊平）。所以这里用 `doc.forEach`
 * 顺次记数——**不读**任何节点属性：节点 attrs 里根本没有 ordinal（只有
 * `sourceRef` 与 `imageAssetId`），按属性找会永远找不到。
 *
 * 装饰用 `Decoration.node` 挂在块上，而不是 `Decoration.inline` 包住那几个字：
 * 这一格的首要职责是让人改字，把整句变成可点区域会抢选区与光标；41 §1.1 要的
 * 只是「已有批注记号保留」，说清「这一块有一条批注」就够了。
 */
function annotationPlugin() {
  return $prose(() => new Plugin<readonly AnnotationPlacement[]>({
    key: ANNOTATION_PLUGIN,
    state: {
      init: () => [],
      apply: (tr, value) => tr.getMeta(setNoteAnnotationPlacements) ?? value,
    },
    props: {
      // `this` 在 PluginSpec 的 props 里绑定到插件本身——`state.plugin(key)` 要的
      // 正是它。写成箭头函数 `this` 就是 undefined，症状是读不到集合、记号不画。
      decorations(state) {
        const placements = this.getState(state) ?? [];
        if (!placements.length) return null;
        const byBlock = placementsByBlock(placements);
        const decorations: Decoration[] = [];
        // 自己记数，别回头查 offset：`doc.forEach` 走的就是块下标的顺序，
        // 回头再扫一遍是 O(n²)，而正文动辄几百块。
        let ordinal = 0;
        state.doc.forEach((node, offset) => {
          const entries = byBlock.get(ordinal);
          ordinal += 1;
          if (!entries) return;
          decorations.push(Decoration.node(offset, offset + node.nodeSize, {
            class: "note-annotation-block",
            "data-annotation-id": entries[0]!.annotationId,
            "data-annotation-number": String(entries[0]!.number),
            "aria-label": entries.length > 1 ? `这一段有 ${entries.length} 条批注` : "这一段有批注",
          }));
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  }));
}

/**
 * 记号上的点击/回车：走 **DOM 事件委托**，不用 PM 的 `handleClick`。
 *
 * `handleClick` 要先 `posAtCoords` 拿到位置才轮到插件——而 jsdom 没有布局，
 * 那一步直接返回 null，插件根本不会被问（实测：事件发了，回调没来）。它还会
 * 与 PM 自己的选区处理抢一次点击。委托监听在编辑器根上，看有没有落在
 * `[data-annotation-id]` 里就开旁页，并 `preventDefault` 掉这一次点击，
 * 于是「点记号 = 读批注」而不是「点记号 = 把光标放这儿再开旁页」。
 */
function noteAnnotationClickHandler(event: React.MouseEvent): void {
  const id = annotationIdFromEvent(event.target);
  if (!id) return;
  event.preventDefault();
  event.stopPropagation();
  openNoteAnnotationRef.current?.(id);
}

function noteAnnotationKeyHandler(event: React.KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-annotation-id]") : null;
  const id = target?.dataset.annotationId;
  if (!id) return;
  event.preventDefault();
  openNoteAnnotationRef.current?.(id);
}

function annotationIdFromEvent(target: EventTarget | null): string | null {
  const element = target instanceof HTMLElement ? target.closest<HTMLElement>("[data-annotation-id]") : null;
  return element?.dataset.annotationId ?? null;
}

function MilkdownBody({ fragment, initialMarkdown, onChange, disabled, onImagePaste, onCaretBlock, annotationPlacements, onOpenAnnotation }: Props) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onImagePasteRef = useRef(onImagePaste);
  onImagePasteRef.current = onImagePaste;
  const onCaretBlockRef = useRef(onCaretBlock);
  onCaretBlockRef.current = onCaretBlock;
  // 记号集合与打开回调：插件是命令式对象，拿不到 props，经这个 ref 过去。
  // 它是**模块级单例**、跨换笔记也活着，所以每次渲染都要覆盖回去，
  // 否则上一篇的记号会留在这一篇上。
  openNoteAnnotationRef.current = onOpenAnnotation;
  // 图片节点的点击放大：节点视图是命令式 DOM，经 ref 把点击交给 React 渲染灯箱。
  const onImageZoomRef = useRef<((src: string, alt: string) => void) | undefined>(undefined);
  onImageZoomRef.current = (src, alt) => setZoom({ src, alt });
  const [zoom, setZoom] = useState<{ readonly src: string; readonly alt: string } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEditor((root) => Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, initialMarkdown);
      // listener 必须按方法调用，不能整体赋值。
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        onChangeRef.current(markdown);
      });
      // Milkdown 没有 setEditable 方法，只读状态经 editorViewOptionsCtx 声明。
      ctx.update(editorViewOptionsCtx, (previous) => ({
        ...previous,
        editable: () => !disabledRef.current,
        attributes: {
          ...previous.attributes,
          "aria-label": "笔记正文编辑区",
          "aria-multiline": "true",
        },
      }));
    })
    .use(commonmark)
    .use(gfm)
    // 块属性要在那七个节点类型上都声明，否则编辑器一次写入就把它们删掉。
    .use(withNoteDocAttrs(paragraphSchema) as never)
    .use(withNoteDocAttrs(headingSchema) as never)
    .use(withNoteDocAttrs(codeBlockSchema) as never)
    .use(withNoteDocAttrs(blockquoteSchema) as never)
    .use(withNoteDocAttrs(bulletListSchema) as never)
    .use(withNoteDocAttrs(orderedListSchema) as never)
    .use(withNoteDocAttrs(imageSchema) as never)
    // 正文与这份文档之间由 ySyncPlugin 双向同步：编辑器打字就是文档的操作，
    // 界面不再经手"整篇正文"。
    .use($prose(() => ySyncPlugin(fragment)))
    // 撤销交给 `yUndoPlugin`：Milkdown 的 `history` 只记这一台机器的事务，
    // 绑上共享文档之后它会撤销到别人刚写的那几个字上。
    .use($prose(() => yUndoPlugin({ undoManager: new Y.UndoManager([fragment, fragment.doc!.getMap("meta")], {
      trackedOrigins: new Set([ySyncPluginKey, NOTE_SOURCE_INPUT_ORIGIN]),
      captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false,
    }) })))
    .use($prose(() => keymap({ "Mod-z": undoCommand, "Mod-Shift-z": redoCommand, "Mod-y": redoCommand })))
    // `listener` 必须在 `clipboard` 之前回到链里：`onChange` 那一路要靠它，
    // 而我重写这条链时把它和 `history` 一起删了（`history` 是故意删的，它不是）。
    .use(listener)
    .use(clipboard)
    .use(imageUploadPlugin(onImagePasteRef))
    .use(imageNodeViewPlugin(onImageZoomRef))
    .use(caretBlockPlugin(onCaretBlockRef))
    .use(codeBlockTabPlugin())
    .use(placeholderPlugin())
    .use(annotationPlugin()));

  // ProseMirror 的 ensureEditable() 只在 view 创建与 view.update() 时执行。
  // disabled 由 true 变 false 时（例如这一版笔记刚读回来）contenteditable 不会
  // 自己同步，编辑器会停在只读；这里手动补上属性。
  useEffect(() => {
    const dom = wrapperRef.current?.querySelector<HTMLElement>(".ProseMirror");
    if (dom) dom.contentEditable = disabled ? "false" : "true";
  }, [disabled]);

  return (
    <div
      className="note-editor"
      ref={wrapperRef}
      onClick={noteAnnotationClickHandler}
      onKeyDown={noteAnnotationKeyHandler}
    >
      <Milkdown />
      {zoom ? (
        <LightboxViewer alt={zoom.alt} count={1} index={0} onClose={() => setZoom(null)}>
          <img src={zoom.src} alt={zoom.alt} />
        </LightboxViewer>
      ) : null}
    </div>
  );
}

/**
 * 控制层：在 provider 内部拿 editor 实例，把命令式操作写进 ref。
 *
 * 同步必须发生在 useEffect 里。`useInstance` 的 loading 由 true 变 false 时只有
 * 本组件重渲染，父组件不会，所以在父组件 render 阶段写 ref 会让外部 ref 一直
 * 停在 null。
 */
function MilkdownControls({
  handleRef,
  externalRef,
  fragment,
  onReady,
  annotationPlacements,
}: {
  readonly handleRef: React.RefObject<NoteMarkdownEditorHandle | null>;
  readonly externalRef?: React.Ref<NoteMarkdownEditorHandle | null>;
  readonly fragment: Y.XmlFragment;
  readonly onReady?: (handle: NoteMarkdownEditorHandle | null) => void;
  readonly annotationPlacements?: readonly AnnotationPlacement[];
}) {
  const [loading, getInstance] = useInstance();

  /**
   * 把记号集合写进插件 state。
   *
   * 组件挂在这里而不是 `MilkdownBody`，是因为**只有它拿得到 view**（`useInstance`）；
   * 而 `MilkdownBody` 同一个 provider 里却拿不到。一次带 meta 的空事务就把集合
   * 送进去了——不动 doc、不进 undo，而插件的 `decorations` 随 state 自动重算。
   *
   * 另有「用户改字导致块下标变了」那一条：由 doc 变化自动重算，不需要这里管。
   */
  const placementsKey = (annotationPlacements ?? [])
    .map((placement) => `${placement.annotationId}@${placement.blocks.map((block) => block.ordinal).join(",")}`)
    .join("|");
  useEffect(() => {
    if (loading) return;
    withReadyEditor(getInstance(), (editor) => editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(setNoteAnnotationPlacements, annotationPlacements ?? []));
    }), undefined);
  }, [loading, placementsKey, annotationPlacements, getInstance]);

  useEffect(() => {
    const writeExternal = (value: NoteMarkdownEditorHandle | null) => {
      if (!externalRef) return;
      if (typeof externalRef === "function") externalRef(value);
      else (externalRef as React.RefObject<NoteMarkdownEditorHandle | null>).current = value;
    };

    /** 每个命令都走同一条「就绪才执行、竞态就放弃」的路。 */
    const run = <T,>(operation: (editor: NonNullable<ReturnType<typeof getInstance>>) => T) => {
      const editor = getInstance();
      withReadyEditor(editor, operation, undefined);
    };
    const command = (...args: readonly unknown[]) => (editor: NonNullable<ReturnType<typeof getInstance>>) => {
      editor.action(callCommand(args[0] as string, ...args.slice(1)));
    };

    const handle: NoteMarkdownEditorHandle | null = loading ? null : {
      getMarkdown: () => withReadyEditor(
        getInstance(),
        (editor) => editor.action((ctx) => readNoteSource(
          ctx.get(editorViewCtx), ctx.get(serializerCtx),
          fragment.doc?.getMap("meta").get("sourceView") as { text: string; document: string } | undefined,
        )),
        null,
      ),
      setMarkdown: (markdown, flush) => run((editor) => editor.action(replaceAll(markdown, flush))),
      focus: () => run((editor) => editor.action((ctx) => { ctx.get(editorViewCtx).focus(); })),
      insertText: (text) => run((editor) => editor.action(insert(text))),
      replaceImageSrc: (oldSrc, newSrc) => run((editor) => editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { state } = view;
        let transaction = state.tr;
        state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs.src === oldSrc) {
            transaction = transaction.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc, alt: "" });
          }
        });
        if (transaction.docChanged) view.dispatch(transaction);
      })),
      toggleStrong: () => run(command(toggleStrongCommand.key)),
      toggleEmphasis: () => run(command(toggleEmphasisCommand.key)),
      toggleInlineCode: () => run(command(toggleInlineCodeCommand.key)),
      toggleHeading: (level) => run(command(wrapInHeadingCommand.key, level)),
      toggleBlockquote: () => run(command(wrapInBlockquoteCommand.key)),
      toggleBulletList: () => run(command(wrapInBulletListCommand.key)),
      toggleOrderedList: () => run(command(wrapInOrderedListCommand.key)),
      toggleLink: (href) => run(command(toggleLinkCommand.key, { href })),
      insertCodeBlock: () => run(command(createCodeBlockCommand.key)),
      insertHr: () => run(command(insertHrCommand.key)),
      applySource: (markdown) => withReadyEditor(getInstance(), (editor) => editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parsed = ctx.get(parserCtx)(markdown);
        const doc = fragment.doc;
        if (!parsed || !doc) return false;
        const meta = doc.getMap("meta");
        const signature = noteSourceSignature(view.state.doc);
        const cache = meta.get("sourceView") as { text: string; document: string } | undefined;
        // Seed the pre-edit source only on real input so syntax-only edits can be undone too.
        if (cache?.document !== signature) doc.transact(() => meta.set("sourceView", {
          text: ctx.get(serializerCtx)(view.state.doc), document: signature,
        }), "note-source-baseline");
        doc.transact(() => {
          applyNoteSource(view, parsed);
          meta.set("sourceView", { text: markdown, document: noteSourceSignature(view.state.doc) });
        }, NOTE_SOURCE_INPUT_ORIGIN);
        return true;
      }), false),
      undo: () => run((editor) => editor.action((ctx) => { const view = ctx.get(editorViewCtx); undoCommand(view.state, view.dispatch); })),
      redo: () => run((editor) => editor.action((ctx) => { const view = ctx.get(editorViewCtx); redoCommand(view.state, view.dispatch); })),
      getPosition: () => withReadyEditor(getInstance(), (editor) => editor.action((ctx) => noteCaretPosition(ctx.get(editorViewCtx))), { block: 0, offset: 0 }),
      focusPosition: (position) => run((editor) => editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        let at = 0;
        const block = Math.min(Math.max(0, position.block), view.state.doc.childCount - 1);
        for (let index = 0; index < block; index += 1) at += view.state.doc.child(index).nodeSize;
        const offset = Math.min(Math.max(0, position.offset), view.state.doc.child(block).content.size);
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(at + 1 + offset))).scrollIntoView());
        view.focus();
      })),
      isComposing: () => withReadyEditor(getInstance(), (editor) => editor.action((ctx) => ctx.get(editorViewCtx).composing), false),
      subscribe: (listener) => {
        const doc = fragment.doc;
        doc?.on("update", listener);
        return () => { doc?.off("update", listener); };
      },
    };

    handleRef.current = handle;
    writeExternal(handle);
    onReady?.(handle);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      writeExternal(null);
      onReady?.(null);
    };
  }, [loading, getInstance, handleRef, externalRef, fragment, onReady]);

  return null;
}

/**
 * 笔记正文编辑器。`defaultValueCtx` 只在创建时读一次，所以换笔记、恢复历史版本
 * 这类外部替换由调用方经 ref 的 `setMarkdown` 完成，而不是靠改 props。
 */
export function NoteMarkdownEditor({
  fragment,
  initialMarkdown,
  onChange,
  disabled,
  onImagePaste,
  onCaretBlock,
  annotationPlacements,
  onOpenAnnotation,
  ref,
  onReady,
}: Props) {
  const handleRef = useRef<NoteMarkdownEditorHandle | null>(null);

  return (
    <MilkdownProvider>
      <MilkdownBody
        fragment={fragment}
        initialMarkdown={initialMarkdown}
        onChange={onChange}
        disabled={disabled}
        onImagePaste={onImagePaste}
        onCaretBlock={onCaretBlock}
        onOpenAnnotation={onOpenAnnotation}
      />
      {/* 记号集合走 props 进插件 state，而不是模块级 ref：ref 那条路试过，
          `MilkdownControls` 的渲染早于 `MilkdownBody` 写 ref，effect 读到的永远是
          上一轮那份（症状是「记号画不出来」）。值进插件 state 之后，
          「批注变了」本身就是一次事务，装饰自动跟上。 */}
      <MilkdownControls handleRef={handleRef} externalRef={ref} fragment={fragment} onReady={onReady}
        annotationPlacements={annotationPlacements} />
    </MilkdownProvider>
  );
}
