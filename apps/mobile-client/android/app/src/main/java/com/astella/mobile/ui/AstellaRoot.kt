package com.astella.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.tween
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.material3.Surface
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.astella.mobile.R
import com.astella.mobile.ui.design.MotionTokens
import kotlinx.coroutines.delay

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Book
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.MainTab
import com.astella.mobile.ui.design.DawnBackground
import com.astella.mobile.ui.design.AstellaAtmosphere
import com.astella.mobile.ui.design.LocalAstellaHaze
import com.astella.mobile.ui.design.astellaGlass
import dev.chrisbanes.haze.rememberHazeState
import dev.chrisbanes.haze.hazeSource
import com.astella.mobile.ui.design.LocalReduceMotion
import com.astella.mobile.ui.design.StudyPalette
import com.astella.mobile.ui.design.rememberSystemReducedMotion
import com.astella.mobile.ui.screens.AccountScreen
import com.astella.mobile.ui.screens.CompanionCenterScreen
import com.astella.mobile.ui.screens.ConversationScreen
import com.astella.mobile.ui.screens.HandScreen
import com.astella.mobile.ui.screens.LoginScreen
import com.astella.mobile.ui.screens.NoteDetailScreen
import com.astella.mobile.ui.screens.NoteFeatureScreen
import com.astella.mobile.ui.screens.NotesScreen
import com.astella.mobile.ui.screens.SessionRecoveryScreen
import com.astella.mobile.ui.screens.MobileSettingsScreen

@Composable
fun AstellaRoot(viewModel: AppViewModel = viewModel()) {
    val state by viewModel.state.collectAsState()
    val haze = rememberHazeState()
    val reduceMotion = state.localReduceMotion || rememberSystemReducedMotion()
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.Conversation) }
    var showAccount by rememberSaveable { mutableStateOf(false) }
    var accountSubpage by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedNoteId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedNoteFeature by rememberSaveable { mutableStateOf<String?>(null) }
    val owner = LocalLifecycleOwner.current
    val page = if (showAccount) "我的" else if (selectedNoteId != null) "阅读手记" else selectedTab.label
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
        if (state.attachmentRevision.isNotEmpty() && (showAccount || selectedNoteId != null || selectedTab != MainTab.Conversation)) {
            showAccount = false; selectedNoteId = null; selectedNoteFeature = null; selectedTab = MainTab.Conversation
        }
    }
    BackHandler(showAccount || selectedNoteId != null || selectedNoteFeature != null) {
        when {
            showAccount && accountSubpage != null -> accountSubpage = null
            showAccount -> showAccount = false
            selectedNoteFeature != null -> selectedNoteFeature = null
            selectedNoteId != null -> selectedNoteId = null
            else -> Unit
        }
    }

    CompositionLocalProvider(LocalReduceMotion provides reduceMotion,LocalAstellaHaze provides haze) {
        if (!state.isAuthenticated) {
            if (viewModel.hasStoredSession()) SessionRecoveryScreen(state, viewModel)
            else LoginScreen(state, viewModel)
            return@CompositionLocalProvider
        }

        val inSubpage = showAccount || selectedNoteId != null || selectedNoteFeature != null
        Box(Modifier.fillMaxSize()) {
        AstellaAtmosphere(Modifier.fillMaxSize().hazeSource(haze))
        Scaffold(
            containerColor = androidx.compose.ui.graphics.Color.Transparent,
            contentWindowInsets = WindowInsets.safeDrawing,
            bottomBar = {
                if (!inSubpage) {
                    Box(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 42.dp,end = 42.dp,top = 8.dp,bottom = 5.dp)) {
                        Row(Modifier.fillMaxWidth().height(69.dp).astellaGlass(29.dp,interactive = true).padding(horizontal = 10.dp,vertical = 5.dp)) {
                            MainTab.entries.forEach { tab ->
                                val selected = selectedTab == tab
                                com.astella.mobile.ui.design.AstellaTap({ selectedTab = tab },Modifier.weight(1f).fillMaxHeight()) {
                                    Column(Modifier.align(Alignment.Center),horizontalAlignment = Alignment.CenterHorizontally,verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Box(Modifier.size(22.dp,25.dp),contentAlignment = Alignment.BottomCenter) {
                                            if (selected) Box(Modifier.align(Alignment.TopCenter).width(13.dp).height(2.dp).background(StudyPalette.accent.copy(alpha = .85f),RoundedCornerShape(2.dp)))
                                            Icon(tabIcon(tab),null,Modifier.size(21.dp),tint = if (selected) StudyPalette.ink else StudyPalette.muted)
                                        }
                                        Text(if (tab == MainTab.Conversation) "伴星" else tab.label,fontSize = androidx.compose.ui.unit.TextUnit(10f,androidx.compose.ui.unit.TextUnitType.Sp),color = if (selected) StudyPalette.ink else StudyPalette.muted)
                                    }
                                }
                            }
                        }
                    }
                }
            },
        ) { inset ->
            DawnBackground(Modifier.padding(inset).pointerInput(Unit) {
                awaitEachGesture { awaitFirstDown(requireUnconsumed = false); viewModel.recordInteraction() }
            }) {
                AnimatedContent(
                    targetState = when {
                        showAccount -> accountSubpage?.let { "account:$it" } ?: "account"
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
                        destination == "account:settings" -> MobileSettingsScreen(
                            state, viewModel, onBack = { accountSubpage = null },
                        )
                        destination == "account:companion" -> CompanionCenterScreen(
                            state, viewModel, onBack = { accountSubpage = null },
                            onConversation = { records ->
                                viewModel.setChatShowsRecords(records)
                                accountSubpage = null
                                showAccount = false
                                selectedNoteFeature = null
                                selectedNoteId = null
                                selectedTab = MainTab.Conversation
                            },
                        )
                        destination == "account" -> AccountScreen(
                            state, viewModel,
                            onBack = { showAccount = false },
                            onSettings = { accountSubpage = "settings" },
                            onCompanion = { accountSubpage = "companion" },
                        )
                        destination.startsWith("feature:") -> NoteFeatureScreen(
                            noteId = destination.substringAfterLast(":"),
                            kind = destination.split(":")[1],
                            state = state,
                            viewModel = viewModel,
                            onBack = { selectedNoteFeature = null },
                            onAccount = { showAccount = true },
                        )
                        destination.startsWith("note:") -> NoteDetailScreen(
                            noteId = selectedNoteId ?: destination.removePrefix("note:"),
                            state = state,
                            viewModel = viewModel,
                            onBack = { selectedNoteId = null },
                            onAccount = { showAccount = true },
                            onContinue = { document ->
                                viewModel.continueWithNote(document)
                                selectedTab = MainTab.Conversation
                                selectedNoteFeature = null
                                selectedNoteId = null
                            },
                            onOpenFeature = { feature -> selectedNoteFeature = feature },
                        )
                        destination == MainTab.Conversation.name -> ConversationScreen(state, viewModel, onAccount = { showAccount = true })
                        destination == MainTab.Hand.name -> HandScreen(
                            state, viewModel,
                            onAccount = { showAccount = true },
                            onConversation = { selectedTab = MainTab.Conversation },
                        )
                        else -> NotesScreen(
                            state,
                            viewModel,
                            onOpenNote = { selectedNoteId = it },
                            onAccount = { showAccount = true },
                            onConversation = { selectedTab = MainTab.Conversation },
                        )
                    }
                }
            }
        }
        }
    }
}

private fun destinationDepth(destination: String): Int = when {
    destination.startsWith("account:") || destination.startsWith("feature:") -> 2
    destination == "account" || destination.startsWith("note:") -> 1
    else -> 0
}

private fun tabIcon(tab: MainTab): ImageVector = when (tab) {
    MainTab.Conversation -> Icons.Filled.ChatBubble
    MainTab.Hand -> Icons.Filled.Inventory2
    MainTab.Notes -> Icons.Filled.Book
}
