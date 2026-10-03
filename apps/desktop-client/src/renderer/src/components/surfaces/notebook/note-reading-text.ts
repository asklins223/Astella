/** KaTeX's visual glyphs and annotation badges aren't note source characters. */
export function noteReadingTextNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node =>
    node.parentElement?.closest("[data-note-decoration]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

export function noteReadingText(root: Node): string {
  return noteReadingTextNodes(root).map(node => node.data).join("");
}

export function noteReadingOffset(root: HTMLElement, node: Node, at: number, fallback: number, edge: "start" | "end"): number {
  if (!root.contains(node)) return fallback;
  const math = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(".note-math");
  const before = document.createRange(); before.selectNodeContents(root);
  // A visual formula is an atom. A partial glyph selection anchors its whole TeX.
  if (math && root.contains(math)) edge === "start" ? before.setEndBefore(math) : before.setEndAfter(math);
  else before.setEnd(node, at);
  return noteReadingTextNodes(root).reduce((length, text) => {
    if (!before.intersectsNode(text)) return length;
    const end = before.endContainer === text ? before.endOffset : text.length;
    return length + end;
  }, 0);
}
