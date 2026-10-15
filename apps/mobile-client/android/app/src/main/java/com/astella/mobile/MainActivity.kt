package com.astella.mobile

import android.os.Bundle
import android.view.DragEvent
import androidx.activity.viewModels
import com.astella.mobile.data.AppViewModel
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
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
            StudyTheme { AstellaRoot(appViewModel) }
        }
    }
}
