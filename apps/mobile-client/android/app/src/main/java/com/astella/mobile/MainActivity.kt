package com.astella.mobile

import android.os.Bundle
import android.view.DragEvent
import androidx.activity.viewModels
import com.astella.mobile.data.AppViewModel
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import com.astella.mobile.ui.AstellaRoot
import com.astella.mobile.ui.design.StudyTheme

class MainActivity : ComponentActivity() {
    private val appViewModel: AppViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.decorView.setOnDragListener { _, event ->
            when (event.action) {
                DragEvent.ACTION_DRAG_STARTED -> event.clipDescription?.let { description ->
                    description.hasMimeType("image/*") || description.hasMimeType("application/pdf") ||
                        description.hasMimeType("application/vnd.openxmlformats-officedocument.wordprocessingml.document") || description.hasMimeType("text/*")
                } ?: false
                DragEvent.ACTION_DROP -> {
                    val uri = event.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
                    if (uri != null) {
                        val permission = requestDragAndDropPermissions(event)
                        if (contentResolver.getType(uri).orEmpty().startsWith("image/")) appViewModel.selectDroppedImage(uri).invokeOnCompletion { permission?.release() }
                        else appViewModel.selectFile(uri).invokeOnCompletion { permission?.release() }
                        true
                    } else false
                }
                else -> true
            }
        }
        setContent {
            val appearance = remember { getSharedPreferences("astella.appearance", MODE_PRIVATE) }
            var themeMode by rememberSaveable {
                mutableStateOf(appearance.getString("theme_mode", if (appearance.getBoolean("dark_mode", false)) "dark" else "light") ?: "light")
            }
            val systemDark = androidx.compose.foundation.isSystemInDarkTheme()
            val darkMode = when (themeMode) { "dark" -> true; "system" -> systemDark; else -> false }
            StudyTheme(darkTheme = darkMode) {
                AstellaRoot(
                    appViewModel,
                    darkTheme = darkMode,
                    onToggleTheme = {
                        themeMode = if (darkMode) "light" else "dark"
                        appearance.edit().putString("theme_mode", themeMode).putBoolean("dark_mode", themeMode == "dark").apply()
                    },
                    themeMode = themeMode,
                    onThemeMode = { next ->
                        themeMode = next
                        appearance.edit().putString("theme_mode", next).putBoolean("dark_mode", next == "dark").apply()
                    },
                )
            }
        }
    }
}
