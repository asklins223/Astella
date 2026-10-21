package com.astella.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.astella.mobile.R
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.MainTab
import com.astella.mobile.data.StartupLoadState
import com.astella.mobile.ui.design.AstellaAtmosphere
import com.astella.mobile.ui.design.AstellaGlyph
import com.astella.mobile.ui.design.AstellaGlyphKind
import com.astella.mobile.ui.design.AstellaTap
import com.astella.mobile.ui.design.DawnBackground
import com.astella.mobile.ui.design.GlassCircleButton
import com.astella.mobile.ui.design.LocalAstellaHaze
import com.astella.mobile.ui.design.LocalReduceMotion
import com.astella.mobile.ui.design.MotionTokens
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.astellaGlass
import com.astella.mobile.ui.design.rememberSystemReducedMotion
import com.astella.mobile.ui.launch.LaunchLanding
import com.astella.mobile.ui.launch.LaunchMotion
import com.astella.mobile.ui.launch.LocalLaunchLanding
import com.astella.mobile.ui.screens.AIAuthScreen
import com.astella.mobile.ui.screens.AccountScreen
import com.astella.mobile.ui.screens.CompanionCenterScreen
import com.astella.mobile.ui.screens.CompanionSettingsScreen
import com.astella.mobile.ui.screens.ConventionsScreen
import com.astella.mobile.ui.screens.ConversationScreen
import com.astella.mobile.ui.screens.LoginScreen
import com.astella.mobile.ui.screens.NoteDetailScreen
import com.astella.mobile.ui.screens.NoteFeatureScreen
import com.astella.mobile.ui.screens.NotesScreen
import com.astella.mobile.ui.screens.OrbitDiaryDetailScreen
import com.astella.mobile.ui.screens.OrbitScreen
import com.astella.mobile.ui.screens.PasswordChangeScreen
import com.astella.mobile.ui.screens.PermissionsScreen
import com.astella.mobile.ui.screens.ProfileScreen
import com.astella.mobile.ui.screens.ReadSettingsScreen
import com.astella.mobile.ui.screens.ServerAddressScreen
import com.astella.mobile.ui.screens.SessionRecoveryScreen
import com.astella.mobile.ui.screens.SettingsScreen
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import kotlinx.coroutines.delay
import androidx.compose.ui.geometry.Rect

@Composable
fun AstellaRoot(
    viewModel: AppViewModel = viewModel(),
    darkTheme: Boolean = false,
    onToggleTheme: () -> Unit = {},
    themeMode: String = if (darkTheme) "dark" else "light",
    onThemeMode: (String) -> Unit = {},
) {
    val state by viewModel.state.collectAsState()
    val haze = rememberHazeState()
    val reduceMotion = state.localReduceMotion || rememberSystemReducedMotion()
    val activity = LocalContext.current as? android.app.Activity
    val darkSystemBars = darkTheme && (state.isAuthenticated || viewModel.hasStoredSession())
    LaunchedEffect(activity, darkSystemBars) {
        activity?.window?.let { window ->
            WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !darkSystemBars
                isAppearanceLightNavigationBars = !darkSystemBars
            }
        }
    }
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.Conversation) }
    // 账户子页按打开顺序入栈：个人资料/个人约定既可从“我的”进入，也可从伴星配置进入，
    // 返回必须回到各自的入口，不能靠一张固定的父页表。
    var accountStack by rememberSaveable { mutableStateOf(emptyList<String>()) }
    val accountSubpage = accountStack.lastOrNull()
    var selectedNoteId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedNoteFeature by rememberSaveable { mutableStateOf<String?>(null) }
    var orbitDiaryDate by rememberSaveable { mutableStateOf<String?>(null) }
    var launchFinished by rememberSaveable { mutableStateOf(false) }
    var companionBounds by remember { mutableStateOf<Rect?>(null) }
    val showsArrival = !launchFinished && state.startupLoadState in setOf(StartupLoadState.Loading, StartupLoadState.Ready)
    val wantsCompanionLanding = selectedTab == MainTab.Conversation && !state.chatShowsRecords &&
        accountSubpage == null && selectedNoteId == null
    LaunchedEffect(state.startupLoadState) {
        if (state.startupLoadState == StartupLoadState.Loading) { launchFinished = false; companionBounds = null }
    }

    /** 一级目的地：切换时清掉所有子路由，避免停留在上一个手记/设置页。 */
    fun navigateTab(tab: MainTab) {
        selectedTab = tab
        accountStack = emptyList()
        selectedNoteId = null
        selectedNoteFeature = null
    }

    fun openSubpage(page: String) {
        accountStack = accountStack + page
    }

    fun closeSubpage() {
        if (accountStack.isNotEmpty()) accountStack = accountStack.dropLast(1)
    }

    val owner = LocalLifecycleOwner.current
    val page = if (selectedNoteId != null) "阅读手记" else selectedTab.label
    val observedPage by rememberUpdatedState(page)
    val observedNote by rememberUpdatedState(selectedNoteId)
    LaunchedEffect(owner, state.profile?.userId) {
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            viewModel.recordInteraction()
            viewModel.reportAwareness("app.foreground", true, observedPage, observedNote)
            try {
                while (true) {
                    delay(15_000)
                    viewModel.reportAwareness(if (viewModel.isQuiet()) "presence.quiet" else "context.updated", true, observedPage, observedNote)
                }
            } finally {
                kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { viewModel.reportAwareness("context.updated", false, observedPage, observedNote) }
            }
        }
    }
    LaunchedEffect(page, selectedNoteId) {
        viewModel.recordInteraction()
        viewModel.reportAwareness("page.arrived", true, page, selectedNoteId)
    }
    LaunchedEffect(state.attachmentRevision) {
        if (state.attachmentRevision.isNotEmpty() && (accountSubpage != null || selectedNoteId != null || selectedTab != MainTab.Conversation)) {
            navigateTab(MainTab.Conversation)
        }
    }
    LaunchedEffect(state.diaryCaptureRequest) {
        if (state.diaryCaptureRequest > 0) navigateTab(MainTab.Conversation)
    }
    BackHandler(accountSubpage != null || selectedNoteId != null || selectedNoteFeature != null) {
        when {
            accountSubpage != null -> closeSubpage()
            selectedNoteFeature != null -> selectedNoteFeature = null
            selectedNoteId != null -> selectedNoteId = null
            else -> Unit
        }
    }

    CompositionLocalProvider(
        LocalReduceMotion provides reduceMotion,
        LocalAstellaHaze provides haze,
        LocalLaunchLanding provides LaunchLanding(showsArrival) { companionBounds = it },
    ) {
        Box(Modifier.fillMaxSize()) {
            if (!state.isAuthenticated) {
                if (viewModel.hasStoredSession()) SessionRecoveryScreen(state, viewModel)
                else LoginScreen(state, viewModel)
            } else {
                val inSubpage = accountSubpage != null || selectedNoteId != null || selectedNoteFeature != null || orbitDiaryDate != null
                Box(Modifier.fillMaxSize()) {
                    AstellaAtmosphere(Modifier.fillMaxSize().hazeSource(haze))
                    Scaffold(
                        containerColor = Color.Transparent,
                        contentWindowInsets = WindowInsets.safeDrawing,
                        bottomBar = {
                            if (!inSubpage && selectedTab != MainTab.Conversation) {
                                Row(
                                    Modifier.fillMaxWidth().navigationBarsPadding()
                                        .padding(start = 20.dp, end = 18.dp, top = 7.dp, bottom = 5.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    MainNavigationDock(
                                        selectedTab = selectedTab,
                                        onSelect = ::navigateTab,
                                        modifier = Modifier.weight(1f).height(66.dp).astellaGlass(29.dp),
                                    )
                                    CompanionShortcut(
                                        onClick = { navigateTab(MainTab.Conversation) },
                                        size = 60.dp,
                                    )
                                }
                            }
                        },
                    ) { inset ->
                        DawnBackground(Modifier.padding(inset).pointerInput(Unit) {
                            awaitEachGesture { awaitFirstDown(requireUnconsumed = false); viewModel.recordInteraction() }
                        }) {
                            AnimatedContent(
                                targetState = when {
                                    accountSubpage != null -> "account:$accountSubpage"
                                    orbitDiaryDate != null -> "orbit:diary:$orbitDiaryDate"
                                    selectedNoteFeature != null -> "feature:${selectedNoteFeature}:${selectedNoteId}"
                                    selectedNoteId != null -> "note:${selectedNoteId}"
                                    else -> selectedTab.name
                                },
                                label = "main-page-transition",
                                transitionSpec = {
                                    if (reduceMotion) {
                                        fadeIn(tween(1)) togetherWith fadeOut(tween(1))
                                    } else {
                                        val initialDepth = destinationDepth(initialState)
                                        val targetDepth = destinationDepth(targetState)
                                        when {
                                            targetDepth > initialDepth ->
                                                (slideInHorizontally(MotionTokens.routePush()) { it } + fadeIn(tween(160))) togetherWith
                                                    (slideOutHorizontally(MotionTokens.routePush()) { -it } + fadeOut(tween(120)))
                                            targetDepth < initialDepth ->
                                                (slideInHorizontally(MotionTokens.routePush()) { -it } + fadeIn(tween(160))) togetherWith
                                                    (slideOutHorizontally(MotionTokens.routePush()) { it } + fadeOut(tween(120)))
                                            else -> fadeIn(tween(180)) togetherWith fadeOut(tween(120))
                                        }
                                    }
                                },
                            ) { destination ->
                                when {
                                    destination == "account:settings" -> SettingsScreen(
                                        state, viewModel,
                                        themeMode = themeMode,
                                        onThemeMode = onThemeMode,
                                        onBack = { closeSubpage() },
                                        onReadSettings = { openSubpage("readSettings") },
                                        onPermissions = { openSubpage("permissions") },
                                        onAiAuth = { openSubpage("aiAuth") },
                                        onServerAddress = { openSubpage("serverAddr") },
                                        onLibrary = { navigateTab(MainTab.Library) },
                                    )
                                    destination == "account:readSettings" -> ReadSettingsScreen(
                                        state, viewModel,
                                        themeMode = themeMode,
                                        onThemeMode = onThemeMode,
                                        onBack = { closeSubpage() },
                                    )
                                    destination == "account:permissions" -> PermissionsScreen(state, onBack = { closeSubpage() })
                                    destination == "account:aiAuth" -> AIAuthScreen(state, viewModel, onBack = { closeSubpage() })
                                    destination == "account:serverAddr" -> ServerAddressScreen(state, viewModel, onBack = { closeSubpage() })
                                    destination == "account:profile" -> ProfileScreen(
                                        state, viewModel,
                                        onBack = { closeSubpage() },
                                        onLibrary = { navigateTab(MainTab.Library) },
                                    )
                                    destination == "account:conventions" -> ConventionsScreen(state, viewModel, onBack = { closeSubpage() })
                                    destination == "account:password" -> PasswordChangeScreen(state, viewModel, onBack = { closeSubpage() })
                                    destination == "account:companion" -> CompanionCenterScreen(
                                        state,
                                        onBack = { closeSubpage() },
                                        onConversation = { records ->
                                            viewModel.setChatShowsRecords(records)
                                            navigateTab(MainTab.Conversation)
                                        },
                                        onConfig = { openSubpage("companionSettings") },
                                        onMemory = {
                                            viewModel.openOrbitSection("memory")
                                            navigateTab(MainTab.Orbit)
                                        },
                                        onDiary = {
                                            viewModel.openOrbitSection("diary")
                                            navigateTab(MainTab.Orbit)
                                        },
                                    )
                                    destination == "account:companionSettings" -> CompanionSettingsScreen(
                                        state,
                                        onBack = { closeSubpage() },
                                        onConventions = { openSubpage("conventions") },
                                        onProfile = { openSubpage("profile") },
                                        onMemory = { navigateTab(MainTab.Orbit) },
                                    )
                                    destination == MainTab.Me.name -> AccountScreen(
                                        state, viewModel,
                                        onLibrary = { navigateTab(MainTab.Library) },
                                        onCompanion = { openSubpage("companion") },
                                        onSubpage = { page -> openSubpage(page) },
                                    )
                                    destination.startsWith("feature:") -> NoteFeatureScreen(
                                        noteId = destination.substringAfterLast(":"),
                                        kind = destination.split(":")[1],
                                        state = state,
                                        viewModel = viewModel,
                                        onBack = { selectedNoteFeature = null },
                                        onAccount = {
                                            selectedNoteFeature = null
                                            navigateTab(MainTab.Me)
                                        },
                                    )
                                    destination.startsWith("note:") -> NoteDetailScreen(
                                        noteId = selectedNoteId ?: destination.removePrefix("note:"),
                                        state = state,
                                        viewModel = viewModel,
                                        onBack = {
                                            selectedNoteId = null
                                            if (state.resultReturnTo != null) {
                                                selectedTab = MainTab.Conversation
                                                viewModel.returnToResultJournal()
                                            }
                                        },
                                        onAccount = {
                                            selectedNoteId = null
                                            selectedNoteFeature = null
                                            navigateTab(MainTab.Me)
                                        },
                                        onContinue = { document ->
                                            viewModel.continueWithNote(document)
                                            navigateTab(MainTab.Conversation)
                                        },
                                        onOpenFeature = { feature -> selectedNoteFeature = feature },
                                        onOpenNote = { id -> selectedNoteId = id },
                                    )
                                    destination == MainTab.Conversation.name -> ConversationScreen(
                                        state = state,
                                        viewModel = viewModel,
                                        onAccount = {
                                            selectedNoteFeature = null
                                            selectedNoteId = null
                                            navigateTab(MainTab.Me)
                                        },
                                        selectedTab = selectedTab,
                                        onSelectTab = ::navigateTab,
                                        onOpenNote = { noteId ->
                                            selectedNoteId = noteId
                                            selectedNoteFeature = null
                                        },
                                        darkTheme = darkTheme,
                                        onToggleTheme = onToggleTheme,
                                    )
                                    destination.startsWith("orbit:diary:") -> OrbitDiaryDetailScreen(
                                        date = destination.removePrefix("orbit:diary:"),
                                        viewModel = viewModel,
                                        onBack = { orbitDiaryDate = null },
                                        onContinue = { date, version ->
                                            viewModel.continueWithDiary(date, version)
                                            orbitDiaryDate = null
                                            navigateTab(MainTab.Conversation)
                                        },
                                    )
                                    destination == MainTab.Orbit.name -> OrbitScreen(
                                        state, viewModel,
                                        onConversation = { navigateTab(MainTab.Conversation) },
                                        onDiaryDay = { orbitDiaryDate = it },
                                    )
                                    else -> NotesScreen(
                                        state,
                                        viewModel,
                                        onOpenNote = { selectedNoteId = it },
                                        onConversation = { navigateTab(MainTab.Conversation) },
                                    )
                                }
                            }
                        }
                    }
                    // 设计稿：阅读与速览等子页保留右下角伴星圆形入口；脑图与版本面板不遮画布。
                    val showsCompanionOrb = inSubpage &&
                        (accountSubpage != null || orbitDiaryDate != null ||
                            (selectedNoteId != null && selectedNoteFeature == null) || selectedNoteFeature == "overview")
                    if (showsCompanionOrb) {
                        Box(
                            Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(end = 18.dp, bottom = 14.dp),
                        ) {
                            CompanionShortcut(
                                onClick = {
                                    if (selectedNoteId != null) state.noteDocument?.let { viewModel.continueWithNote(it) }
                                    selectedNoteId = null
                                    selectedNoteFeature = null
                                    navigateTab(MainTab.Conversation)
                                },
                                size = 56.dp,
                            )
                        }
                    }
                }
            }
            if (showsArrival) {
                LaunchMotion(
                    dark = darkTheme, reduced = reduceMotion,
                    ready = state.startupLoadState == StartupLoadState.Ready && (!wantsCompanionLanding || companionBounds != null),
                    target = if (wantsCompanionLanding) companionBounds else null,
                    onFinished = { launchFinished = true },
                )
            }
        }
    }
}

@Composable
fun CompanionShortcut(onClick: () -> Unit, size: androidx.compose.ui.unit.Dp = 58.dp, modifier: Modifier = Modifier) {
    AstellaTap(
        onClick,
        modifier.size(size).astellaGlass(size / 2, interactive = true)
            .semantics { contentDescription = "打开伴星" },
    ) {
        AstellaGlyph(
            AstellaGlyphKind.Companion,
            Modifier.align(Alignment.Center).size(size * .42f),
            tint = StudyPalette.accent,
        )
    }
}

@Composable
fun MainNavigationDock(
    selectedTab: MainTab,
    onSelect: (MainTab) -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduceMotion = LocalReduceMotion.current
    Box(modifier) {
        BoxWithConstraintsCompat(Modifier.fillMaxWidth().height(66.dp)) { maxWidth ->
            val pad = 5.dp
            val itemWidth = (maxWidth - pad * 2) / MainTab.entries.size
            val targetOffset = pad + itemWidth * MainTab.entries.indexOf(selectedTab)
            val selectionOffset by animateDpAsState(
                targetOffset,
                animationSpec = if (reduceMotion) snap() else MotionTokens.segment(),
                label = "dock-selection-lens",
            )
            val shape = RoundedCornerShape(21.dp)
            Box(
                Modifier.offset(x = selectionOffset, y = pad)
                    .width(itemWidth)
                    .height(56.dp)
                    .background(
                        Brush.verticalGradient(
                            listOf(Color.White.copy(alpha = .86f), Color.White.copy(alpha = .18f)),
                        ),
                        shape,
                    )
                    .border(.7.dp, Color.White.copy(alpha = .8f), shape),
            )
            Row(Modifier.fillMaxSize().padding(horizontal = pad)) {
                MainTab.entries.forEach { tab ->
                    val selected = selectedTab == tab
                    com.astella.mobile.ui.design.AstellaTap(
                        onClick = { onSelect(tab) },
                        modifier = Modifier.weight(1f).fillMaxHeight(),
                    ) {
                        Column(
                            Modifier.align(Alignment.Center),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            AstellaGlyph(
                                when (tab) {
                                    MainTab.Conversation -> AstellaGlyphKind.Companion
                                    MainTab.Library -> AstellaGlyphKind.Library
                                    MainTab.Orbit -> AstellaGlyphKind.Orbit
                                    MainTab.Me -> AstellaGlyphKind.Person
                                },
                                Modifier.size(23.dp, 26.dp),
                                tint = if (selected) StudyPalette.accent else StudyPalette.dockInactive,
                            )
                            Text(
                                tab.label,
                                fontSize = 10.sp,
                                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                                color = if (selected) StudyPalette.accent else StudyPalette.dockInactive,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** BoxWithConstraints 的最小包装，避免各屏幕直接依赖实验 API 签名。 */
@Composable
private fun BoxWithConstraintsCompat(modifier: Modifier, content: @Composable (androidx.compose.ui.unit.Dp) -> Unit) {
    androidx.compose.foundation.layout.BoxWithConstraints(modifier) {
        content(maxWidth)
    }
}

private fun destinationDepth(destination: String): Int = when {
    destination.startsWith("account:") -> 2
    destination.startsWith("orbit:diary:") -> 2
    destination.startsWith("feature:") -> 2
    destination == "account" || destination.startsWith("note:") -> 1
    else -> 0
}
