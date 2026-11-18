(function () {
  var BOOT = window.__ASTELLA_BOOT__ || { contract: {}, platform: "darwin" };
  var CONTRACT_VERSION = "desktop-ipc-v1";

  function invoke(channel, input) {
    return window.__TAURI_INTERNALS__.invoke("astella_invoke", { channel: channel, input: input || {} });
  }

  function failureEnvelope(code) {
    return {
      version: 1,
      ok: false,
      error: { code: code, safeMessageKey: "error." + code, retry: "never" },
      requestId: "tauri-bridge",
      correlationId: "tauri-bridge",
      schemaRevision: CONTRACT_VERSION,
    };
  }

  // 未移植的通道：与网关失败同形（feature_disabled），不是"方法不存在"——
  // 渲染层按自己的失败表给一句"当前环境未启用"，而不是白屏。
  function unavailable() {
    return Promise.resolve(failureEnvelope("feature_disabled"));
  }

  function call(channel) {
    return function (input) { return invoke(channel, input); };
  }

  var listeners = {};
  var pollTimers = {};

  var astella = {
    contract: BOOT.contract,
    runtime: {
      getSnapshot: call("astella.v1.runtime.getSnapshot"),
      retryApiConnection: call("astella.v1.runtime.retryApiConnection"),
      getHealth: call("astella.v1.runtime.getHealth"),
      cancel: unavailable,
    },
    navigation: {
      resolve: call("astella.v1.navigation.resolve"),
      go: call("astella.v1.navigation.go"),
      back: call("astella.v1.navigation.back"),
      restore: call("astella.v1.navigation.restore"),
    },
    auth: {
      getState: call("astella.v1.auth.getState"),
      login: call("astella.v1.auth.login"),
      logout: call("astella.v1.auth.logout"),
      register: call("astella.v1.auth.register"),
      joinWorkspace: call("astella.v1.auth.joinWorkspace"),
      leaveWorkspace: call("astella.v1.auth.leaveWorkspace"),
      changePassword: call("astella.v1.auth.changePassword"),
      getProfile: call("astella.v1.auth.getProfile"),
      updateProfile: call("astella.v1.auth.updateProfile"),
      getAvatar: call("astella.v1.auth.getAvatar"),
      uploadAvatar: call("astella.v1.auth.uploadAvatar"),
      getRememberedAccount: call("astella.v1.auth.getRememberedAccount"),
      forgetRememberedAccount: call("astella.v1.auth.forgetRememberedAccount"),
      resumeRememberedAccount: call("astella.v1.auth.resumeRememberedAccount"),
      logout: unavailable,
      register: unavailable,
      reauthenticate: unavailable,
      changePassword: unavailable,
      sendEmailCode: unavailable,
      loginWithCode: unavailable,
      resetPassword: unavailable,
      joinWorkspace: unavailable,
      getProfile: unavailable,
      updateProfile: unavailable,
      uploadAvatar: unavailable,
      getAvatar: unavailable,
      leaveWorkspace: unavailable,
      getSurfaceManifest: unavailable,
    },
    update: {
      getState: call("astella.v1.update.getState"),
      check: call("astella.v1.update.check"),
      download: call("astella.v1.update.download"),
      install: call("astella.v1.update.install"),
      acknowledgeInstalled: call("astella.v1.update.acknowledgeInstalled"),
    },
    capabilities: {
      get: call("astella.v1.capabilities.get"),
    },
    note: {
      list: call("astella.v1.note.list"),
      get: call("astella.v1.note.get"),
      create: call("astella.v1.note.create"),
      uploadImage: call("astella.v1.note.image.upload"),
      save: call("astella.v1.note.save"),
      exportMarkdown: call("astella.v1.notes.markdownExport"),
      setShareScope: call("astella.v1.note.setShareScope"),
      doc: {
        state: call("astella.v1.note.doc.state"),
        syncUpdate: call("astella.v1.note.doc.syncUpdate"),
        syncTitle: call("astella.v1.note.doc.syncTitle"),
        presence: call("astella.v1.note.doc.presence"),
        draftSave: call("astella.v1.note.doc.draft.save"),
        draftGet: call("astella.v1.note.doc.draft.get"),
        draftClear: call("astella.v1.note.doc.draft.clear"),
      },
      delete: call("astella.v1.note.delete"),
      restore: call("astella.v1.note.restore"),
      presenceList: call("astella.v1.note.presenceList"),
    },
    agent: {
      listLongGoals: call("astella.v1.agent.long-goals.list"),
      listRuns: call("astella.v1.agent.runs.list"),
      getRunHistory: call("astella.v1.agent.runs.history"),
      getRun: call("astella.v1.agent.run.get"),
      createRun: call("astella.v1.agent.runs.create"),
      reviseRun: call("astella.v1.agent.runs.revise"),
      controlRun: call("astella.v1.agent.runs.control"),
      listSelfNotes: call("astella.v1.agent.selfNotes.list"),
      getSelfNoteHistory: call("astella.v1.agent.selfNotes.history"),
      writeSelfNote: call("astella.v1.agent.selfNotes.write"),
      controlSelfNote: call("astella.v1.agent.selfNotes.control"),
      listMethods: call("astella.v1.agent.methods.list"),
      proposeMethod: call("astella.v1.agent.method.propose"),
      reviseMethod: call("astella.v1.agent.method.revise"),
      controlMethod: call("astella.v1.agent.method.control"),
      getMethodHistory: call("astella.v1.agent.method.history"),
      getMethodUses: call("astella.v1.agent.method.uses"),
      feedbackMethod: call("astella.v1.agent.method.feedback"),
    },
    invites: {
      create: call("astella.v1.invite.create"),
      list: call("astella.v1.invite.list"),
      revoke: call("astella.v1.invite.revoke"),
    },
    members: {
      list: call("astella.v1.member.list"),
      remove: call("astella.v1.member.remove"),
    },
    noteWriting: {
      perform: call("astella.v1.noteWriting.perform"),
    },
    noteAnnotation: {
      list: call("astella.v1.noteAnnotation.list"),
    },
    noteExpansion: {
      getTask: call("astella.v1.noteExpansion.getTask"),
    },
    noteLearningArtifact: {
      getTask: call("astella.v1.noteLearningArtifact.taskGet"),
    },
    noteOverview: {
      getTask: call("astella.v1.noteOverview.getTask"),
    },
    noteLearningCard: {
      get: call("astella.v1.noteLearningCard.get"),
      generate: call("astella.v1.noteLearningCard.generate"),
      startAttempt: call("astella.v1.noteLearningCard.startAttempt"),
      answer: call("astella.v1.noteLearningCard.answer"),
      complete: call("astella.v1.noteLearningCard.complete"),
      history: call("astella.v1.noteLearningCard.history"),
    },
    noteMindMap: {
      getTask: call("astella.v1.noteMindMap.getTask"),
      source: call("astella.v1.noteMindMap.source"),
    },
    understanding: {
      getTopology: call("astella.v1.understanding.getTopology"),
      getNoteDeepening: call("astella.v1.understanding.getNoteDeepening"),
    },
    artifact: {
      ensure: call("astella.v1.artifact.ensure"),
    },
    source: {
      list: call("astella.v1.source.list"),
      archive: call("astella.v1.source.archive"),
      createNote: call("astella.v1.source.createNote"),
      reparse: call("astella.v1.source.reparse"),
      listNotes: call("astella.v1.source.notes"),
      bundleImport: call("astella.v1.source.bundleImport"),
      get: call("astella.v1.source.get"),
      getImage: call("astella.v1.source.getImage"),
    },
    workspace: {
      list: call("astella.v1.workspace.list"),
      switch: call("astella.v1.workspace.switch"),
      create: call("astella.v1.workspace.create"),
      rename: call("astella.v1.workspace.rename"),
      dissolvePreview: call("astella.v1.workspace.dissolvePreview"),
      dissolve: call("astella.v1.workspace.dissolve"),
      transferOwnership: call("astella.v1.workspace.transferOwnership"),
      getAiAuditLog: call("astella.v1.workspace.getAiAuditLog"),
      export: call("astella.v1.workspace.export"),
      getAiSettings: call("astella.v1.workspace.getAiSettings"),
      updateAiConsent: call("astella.v1.workspace.updateAiConsent"),
      updateAiDataPolicy: call("astella.v1.workspace.updateAiDataPolicy"),
    },
    search: {
      global: call("astella.v1.search.global"),
      drift: call("astella.v1.search.drift"),
      reindex: call("astella.v1.search.reindex"),
      drift: unavailable,
      reindex: unavailable,
    },
    room: {
      getProjection: call("astella.v1.room.getProjection"),
      patchProfile: call("astella.v1.companion.room.patchProfile"),
    },
    openedFile: {
      take: call("astella.v1.openedFile.take"),
      prepareImport: unavailable,
      reveal: call("astella.v1.openedFile.reveal"),
      // 桌面端是推送；这里用契约相同的 take 轮询：拿到非空批就分发。
      onIncoming: function (listener) {
        var active = true;
        var timer = setInterval(function () {
          window.__TAURI_INTERNALS__.invoke("astella_invoke", { channel: "astella.v1.openedFile.take", input: {} })
            .then(function (result) { if (active && result && result.ok && result.data) listener(result.data); })
            .catch(function () {});
        }, 1500);
        return function () { active = false; clearInterval(timer); };
      },
    },
    clipboard: {
      readLinks: call("astella.v1.clipboard.readLinks"),
      writeText: call("astella.v1.clipboard.writeText"),
    },
    shell: {
      openExternal: call("astella.v1.shell.openExternal"),
    },
    companion: {
      uploadFile: call("astella.v1.companion.file.upload"),
      bridge: {
        setContext: call("astella.v1.companion.bridge.setContext"),
        clearContext: call("astella.v1.companion.bridge.clearContext"),
      },
      uploadImage: call("astella.v1.companion.image.upload"),
      data: {
        deleteAudit: call("astella.v1.companion.audit.delete"),
        export: call("astella.v1.companion.data.export"),
      },
      chat: {
        ensureConversation: call("astella.v1.companion.chat.ensureConversation"),
        sendTurn: call("astella.v1.companion.chat.sendTurn"),
        listMessages: call("astella.v1.companion.chat.listMessages"),
        getProposal: call("astella.v1.companion.chat.proposal.get"),
        decideProposal: call("astella.v1.companion.chat.proposal.decide"),
        listAgentRoutes: call("astella.v1.companion.chat.agentRoutes.list"),
        listRunNodes: call("astella.v1.companion.chat.runNodes.list"),
        listRunVoiceSegments: call("astella.v1.companion.chat.runVoiceSegments.list"),
        cancelRun: call("astella.v1.companion.chat.cancelRun"),
        resumeRun: call("astella.v1.companion.chat.resumeRun"),
      },
      activity: {
        timeline: call("astella.v1.companion.activity.timeline"),
        present: call("astella.v1.companion.activity.present"),
        ack: call("astella.v1.companion.activity.ack"),
      },
      account: {
        getState: call("astella.v1.companion.account.getState"),
        patchState: call("astella.v1.companion.account.patchState"),
        transitionOnboarding: call("astella.v1.companion.onboarding.transition"),
      },
      discovery: {
        get: call("astella.v1.companion.discovery.get"),
        collect: call("astella.v1.companion.discovery.collect"),
        uncollect: call("astella.v1.companion.discovery.uncollect"),
        annotate: call("astella.v1.companion.discovery.annotate"),
        state: call("astella.v1.companion.discovery.state"),
      },
      journey: {
        bootstrap: call("astella.v1.companion.journey.bootstrap"),
        get: call("astella.v1.companion.journey.get"),
        act: call("astella.v1.companion.journey.action"),
        actOnInvitation: call("astella.v1.companion.invitation.action"),
      },
      initiative: {
        getPreferences: call("astella.v1.companion.initiative.getPreferences"),
        setPreferences: call("astella.v1.companion.initiative.setPreferences"),
      },
      history: {
        list: call("astella.v1.companion.history.list"),
        search: call("astella.v1.companion.history.search"),
        clear: call("astella.v1.companion.history.clear"),
      },
      daily: {
        get: call("astella.v1.companion.daily.get"),
        month: call("astella.v1.companion.daily.month"),
        hide: call("astella.v1.companion.daily.hide"),
        unhide: call("astella.v1.companion.daily.unhide"),
        delete: call("astella.v1.companion.daily.delete"),
      },
      memory: {
        list: call("astella.v1.companion.memory.list"),
        create: call("astella.v1.companion.memory.create"),
        correct: call("astella.v1.companion.memory.correct"),
        revisions: call("astella.v1.companion.memory.revisions"),
        dispute: call("astella.v1.companion.memory.dispute"),
        restoreDeleted: call("astella.v1.companion.memory.restore-deleted"),
        dismiss: call("astella.v1.companion.memory.dismiss"),
        delete: call("astella.v1.companion.memory.delete"),
        erase: call("astella.v1.companion.memory.erase"),
        clear: call("astella.v1.companion.memory.clear"),
        clearDerived: call("astella.v1.companion.derivedData.clear"),
        rebuildEmbeddings: call("astella.v1.companion.memory.rebuildEmbeddings"),
        confirm: call("astella.v1.companion.memory.confirm"),
        pin: call("astella.v1.companion.memory.pin"),
        unpin: call("astella.v1.companion.memory.unpin"),
        archive: call("astella.v1.companion.memory.archive"),
        restore: call("astella.v1.companion.memory.restore"),
        summarizeRecent: call("astella.v1.companion.memory.summarizeRecent"),
        budget: call("astella.v1.companion.memory.budget"),
        moveBudgetTier: call("astella.v1.companion.memory.budgetMove"),
        starMap: call("astella.v1.companion.memory.starMap"),
        recycleList: call("astella.v1.companion.memory.recycle-list"),
        conflicts: call("astella.v1.companion.memory.conflicts"),
        resolveConflict: call("astella.v1.companion.memory.resolveConflict"),
      },
      persona: {
        get: call("astella.v1.companion.persona.get"),
        patch: call("astella.v1.companion.persona.patch"),
        versions: call("astella.v1.companion.persona.versions"),
        pending: call("astella.v1.companion.persona.pending"),
        restore: call("astella.v1.companion.persona.restore"),
        reset: call("astella.v1.companion.persona.reset"),
        stage: call("astella.v1.companion.persona.stage"),
        activate: call("astella.v1.companion.persona.activate"),
      },
      voicePreference: {
        get: call("astella.v1.companion.voicePreference.get"),
        patch: call("astella.v1.companion.voicePreference.patch"),
      },
      answerMode: {
        get: call("astella.v1.companion.answerMode.get"),
        patch: call("astella.v1.companion.answerMode.patch"),
      },
      voice: {
        transcribe: call("astella.v1.companion.voice.transcribe"),
        asrModel: {
          getState: call("astella.v1.companion.voice.asrModel.state"),
          download: call("astella.v1.companion.voice.asrModel.download"),
          cancel: call("astella.v1.companion.voice.asrModel.cancel"),
          remove: call("astella.v1.companion.voice.asrModel.remove"),
        },
      },
      model: {
        getState: call("astella.v1.companion.model.state"),
        download: call("astella.v1.companion.model.download"),
        cancel: call("astella.v1.companion.model.cancel"),
        remove: call("astella.v1.companion.model.remove"),
      },
    },
    subscriptions: {
      subscribe: function (input) {
        return invoke("astella.v1.subscriptions.subscribe", input).then(function (result) {
          // noteDoc 订阅：主进程侧已开好活会话，这里用同契约轮询把远端增量送给监听者。
          if (result && result.ok && result.data && typeof result.data.subscriptionId === "string") {
            var subscriptionId = result.data.subscriptionId;
            var prefix = "note-doc:";
            if (subscriptionId.indexOf(prefix) === 0) {
              var noteId = subscriptionId.slice(prefix.length);
              var scope = result.data.authorizedScope || "read-write";
              listeners[subscriptionId] = listeners[subscriptionId] || [];
              setTimeout(function () {
                var statusFrame = {
                  version: 1,
                  data: { kind: "note_doc_event", noteId: noteId, event: { type: "status", status: "authenticated", authorizedScope: scope } },
                };
                (listeners[subscriptionId] || []).forEach(function (listener) { listener(statusFrame); });
              }, 0);
              var timer = setInterval(function () {
                window.__TAURI_INTERNALS__.invoke("astella_invoke", {
                  channel: "astella.v1.note.doc.pollUpdates",
                  input: { noteId: noteId },
                }).then(function (polled) {
                  if (!polled || !polled.ok) return;
                  (polled.data.updates || []).forEach(function (update) {
                    var frame = {
                      version: 1,
                      data: { kind: "note_doc_event", noteId: noteId, event: { type: "update", update: update } },
                    };
                    (listeners[subscriptionId] || []).forEach(function (listener) { listener(frame); });
                  });
                  (polled.data.presence || []).forEach(function (presence) {
                    var frame = {
                      version: 1,
                      data: { kind: "note_doc_event", noteId: noteId, event: presence },
                    };
                    (listeners[subscriptionId] || []).forEach(function (listener) { listener(frame); });
                  });
                }).catch(function () {});
              }, 300);
              pollTimers[subscriptionId] = timer;
            } else if (subscriptionId.indexOf("companion-chat:") === 0) {
              // 聊天 SSE：Rust 侧在拉流，这里把到帧队列转给监听者（300ms 同款节拍）。
              var chatTimer = setInterval(function () {
                window.__TAURI_INTERNALS__.invoke("astella_invoke", {
                  channel: "astella.v1.companion.chat.pollEvents",
                  input: { subscriptionId: subscriptionId },
                }).then(function (polled) {
                  if (!polled || !polled.ok) return;
                  (polled.data.events || []).forEach(function (frame) {
                    (listeners[subscriptionId] || []).forEach(function (listener) { listener(frame); });
                  });
                  if (polled.data.closed) {
                    clearInterval(pollTimers[subscriptionId]);
                    delete pollTimers[subscriptionId];
                  }
                }).catch(function () {});
              }, 300);
              pollTimers[subscriptionId] = chatTimer;
            }
          }
          return result;
        });
      },
      unsubscribe: function (input) {
        if (input && input.subscriptionId && pollTimers[input.subscriptionId]) {
          clearInterval(pollTimers[input.subscriptionId]);
          delete pollTimers[input.subscriptionId];
        }
        return invoke("astella.v1.subscriptions.unsubscribe", input);
      },
      onEvent: function (subscriptionId, listener) {
        var bucket = listeners[subscriptionId] || (listeners[subscriptionId] = []);
        bucket.push(listener);
        return function () {
          var index = bucket.indexOf(listener);
          if (index >= 0) bucket.splice(index, 1);
        };
      },
    },
    window: {
      getState: call("astella.v1.window.getState"),
      setTitlebarTheme: unavailable,
      focus: unavailable,
    },
  };

  astella = new Proxy(astella, {
    get: function (target, property) {
      if (property in target) return target[property];
      if (typeof property === "symbol" || property === "then") return undefined;
      var namespace = new Proxy({}, { get: function () { return unavailable; } });
      target[property] = namespace;
      return namespace;
    },
  });

  var renderingState = {
    supported: true,
    configuredMode: "default",
    activeMode: "default",
    restartRequired: false,
    automaticFallbackReason: null,
  };
  function unsubscribe() { return function () {}; }

  var desktop = {
    platform: BOOT.platform,
    contract: BOOT.contract,
    rendering: {
      getState: function () { return Promise.resolve(renderingState); },
      setMode: function () { return Promise.resolve(renderingState); },
      reportGraphicsFailure: function () { return Promise.resolve(renderingState); },
      onStateChanged: unsubscribe,
    },
    setTitleBarTheme: function () {},
    controlWindow: function (action) {
      window.__TAURI_INTERNALS__.invoke("window_control", { action: String(action) }).catch(function () {});
    },
    onWindowState: unsubscribe,
    onWindowFrame: function (listener) {
      var active = true;
      window.__TAURI_INTERNALS__.invoke("window_frame", {}).then(function (snapshot) {
        if (active && snapshot && typeof listener === "function") listener(snapshot);
      }).catch(function () {});
      return function () { active = false; };
    },
    onUpdateState: unsubscribe,
  };

  // 窗口缩放快捷键（Cmd/Ctrl + / - / 0），与 Electron 版同一档位。
  window.addEventListener("keydown", function (event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    var direction = event.key === "=" || event.key === "+" ? "in"
      : event.key === "-" ? "out"
      : event.key === "0" ? "reset"
      : null;
    if (!direction) return;
    event.preventDefault();
    window.__TAURI_INTERNALS__.invoke("window_zoom", { direction: direction }).catch(function () {});
  }, true);

  Object.defineProperty(window, "astella", { value: astella, configurable: false, writable: false });
  Object.defineProperty(window, "astellaDesktop", { value: desktop, configurable: false, writable: false });

  // 启动探针（切片 1 起保留，切片 3 继续用来验证桥确实喂饱了门）。
  function report(kind, data) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke("probe_report", { report: JSON.stringify({ kind: kind, data: data }) });
      }
    } catch (error) {
      /* probe must never break the page */
    }
  }
  window.addEventListener("error", function (event) {
    report("window-error", { message: String(event.message) });
  });
  window.addEventListener("unhandledrejection", function (event) {
    report("unhandled-rejection", { reason: String(event.reason) });
  });
  setTimeout(function () {
    var root = document.getElementById("root");
    var probeCanvas = document.createElement("canvas");
    report("boot", {
      href: String(location.href),
      rootChildren: root ? root.childElementCount : -1,
      text: root && root.innerText ? root.innerText.slice(0, 160) : "",
      canvasCount: document.querySelectorAll("canvas").length,
      webgl2: Boolean(probeCanvas.getContext("webgl2")),
      fonts: document.fonts ? document.fonts.status : "unsupported",
      version: BOOT.version || "unknown",
    });
  }, 6000);
  setTimeout(function () {
    var root = document.getElementById("root");
    report("boot2", { text: root && root.innerText ? root.innerText.slice(0, 200) : "" });
  }, 14000);
})();
