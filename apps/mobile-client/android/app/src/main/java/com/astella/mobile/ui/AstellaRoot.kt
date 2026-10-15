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
    val reduceMotion = state.localReduceMotion || rememberSystemReducedMotion()
    var selectedTab by rememberSaveable { mutableStateOf(MainTab.Conversation) }
    var showAccount by rememberSaveable { mutableStateOf(false) }
    var accountSubpage by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedNoteId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedNoteFeature by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(showAccount || selectedNoteId != null || selectedNoteFeature != null) {
        when {
            showAccount && accountSubpage != null -> accountSubpage = null
            showAccount -> showAccount = false
            selectedNoteFeature != null -> selectedNoteFeature = null
            selectedNoteId != null -> selectedNoteId = null
            else -> Unit
        }
    }

    CompositionLocalProvider(LocalReduceMotion provides state.localReduceMotion) {
        if (!state.isAuthenticated) {
            if (viewModel.hasStoredSession()) SessionRecoveryScreen(state, viewModel)
            else LoginScreen(state, viewModel)
            return@CompositionLocalProvider
        }

        val inSubpage = showAccount || selectedNoteId != null || selectedNoteFeature != null
        Scaffold(
            contentWindowInsets = WindowInsets.safeDrawing,
            bottomBar = {
                if (!inSubpage) {
                    NavigationBar(
                        containerColor = StudyPalette.paper.copy(alpha = .96f),
                        tonalElevation = 1.dp,
                    ) {
                        MainTab.entries.forEach { tab ->
                            NavigationBarItem(
                                selected = selectedTab == tab,
                                onClick = { selectedTab = tab },
                                icon = { Icon(tabIcon(tab), contentDescription = null) },
                                label = { Text(tab.label) },
                                alwaysShowLabel = true,
                            )
                        }
                    }
                }
            },
        ) { inset ->
            DawnBackground(Modifier.padding(inset)) {
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
                                    (slideInHorizontally(tween(280)) { it } + fadeIn(tween(160))) togetherWith
                                        (slideOutHorizontally(tween(280)) { -it } + fadeOut(tween(120)))
                                targetDepth < initialDepth ->
                                    (slideInHorizontally(tween(280)) { -it } + fadeIn(tween(160))) togetherWith
                                        (slideOutHorizontally(tween(280)) { it } + fadeOut(tween(120)))
                                else -> fadeIn(tween(180)) togetherWith fadeOut(tween(120))
                            }
                        }
                    },
                ) { destination ->
                    when {
                        showAccount && accountSubpage == "settings" -> MobileSettingsScreen(
                            state, viewModel, onBack = { accountSubpage = null },
                        )
                        showAccount && accountSubpage == "companion" -> CompanionCenterScreen(
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
                        showAccount -> AccountScreen(
                            state, viewModel,
                            onBack = { showAccount = false },
                            onSettings = { accountSubpage = "settings" },
                            onCompanion = { accountSubpage = "companion" },
                        )
                        selectedNoteFeature != null && selectedNoteId != null -> NoteFeatureScreen(
                            noteId = selectedNoteId!!,
                            kind = selectedNoteFeature!!,
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
