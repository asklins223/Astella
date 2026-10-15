package com.astella.mobile.ui

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.isSystemInDarkTheme
import com.astella.mobile.R

private data class StudyColors(
    val ink: Color,
    val muted: Color,
    val blue: Color,
    val blueDeep: Color,
    val sky: Color,
    val canvas: Color,
    val paper: Color,
    val inset: Color,
    val paperEdge: Color,
    val success: Color,
    val danger: Color,
)

private val LightStudyColors = StudyColors(
    ink = Color(0xFF1C1C1E),
    muted = Color(0xFF6C6C70),
    blue = Color(0xFF007AFF),
    blueDeep = Color(0xFF007AFF),
    sky = Color(0xFFEAF3FF),
    canvas = Color(0xFFFAFAFC),
    paper = Color.White,
    inset = Color(0xFFF2F2F7),
    paperEdge = Color(0xFFE1E1E6),
    success = Color(0xFF34C759),
    danger = Color(0xFFFF3B30),
)

private val DarkStudyColors = StudyColors(
    ink = Color(0xFFF5F5F7),
    muted = Color(0xFF98989D),
    blue = Color(0xFF0A84FF),
    blueDeep = Color(0xFF0A84FF),
    sky = Color(0xFF162A40),
    canvas = Color(0xFF101012),
    paper = Color(0xFF1C1C1E),
    inset = Color(0xFF2C2C2E),
    paperEdge = Color(0xFF38383A),
    success = Color(0xFF30D158),
    danger = Color(0xFFFF453A),
)

private val LocalStudyColors = compositionLocalOf { LightStudyColors }

object StudyPalette {
    val ink: Color @Composable get() = LocalStudyColors.current.ink
    val muted: Color @Composable get() = LocalStudyColors.current.muted
    val blue: Color @Composable get() = LocalStudyColors.current.blue
    val blueDeep: Color @Composable get() = LocalStudyColors.current.blueDeep
    val sky: Color @Composable get() = LocalStudyColors.current.sky
    val canvas: Color @Composable get() = LocalStudyColors.current.canvas
    val paper: Color @Composable get() = LocalStudyColors.current.paper
    val inset: Color @Composable get() = LocalStudyColors.current.inset
    val paperEdge: Color @Composable get() = LocalStudyColors.current.paperEdge
    val success: Color @Composable get() = LocalStudyColors.current.success
    val danger: Color @Composable get() = LocalStudyColors.current.danger
}

@Composable
fun StudyTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val palette = if (dark) DarkStudyColors else LightStudyColors
    val scheme = if (dark) {
        darkColorScheme(
            primary = palette.blueDeep,
            onPrimary = Color.White,
            secondary = palette.blue,
            secondaryContainer = palette.sky,
            onSecondaryContainer = palette.blueDeep,
            background = palette.canvas,
            surface = palette.paper,
            surfaceVariant = palette.sky,
            onBackground = palette.ink,
            onSurface = palette.ink,
            outline = palette.paperEdge,
            error = palette.danger,
        )
    } else {
        lightColorScheme(
            primary = palette.blueDeep,
            onPrimary = Color.White,
            secondary = palette.blue,
            secondaryContainer = palette.sky,
            onSecondaryContainer = palette.blueDeep,
            background = palette.canvas,
            surface = palette.paper,
            surfaceVariant = palette.sky,
            onBackground = palette.ink,
            onSurface = palette.ink,
            outline = palette.paperEdge,
            error = palette.danger,
        )
    }
    CompositionLocalProvider(LocalStudyColors provides palette) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

@Composable
fun rememberSystemReducedMotion(): Boolean {
    val context = LocalContext.current
    fun systemAnimationsDisabled(): Boolean = runCatching {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) <= 0f
    }.getOrDefault(false)

    var reduced by remember(context) { mutableStateOf(systemAnimationsDisabled()) }
    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                reduced = systemAnimationsDisabled()
            }
        }
        val uri = Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE)
        context.contentResolver.registerContentObserver(uri, false, observer)
        onDispose { context.contentResolver.unregisterContentObserver(observer) }
    }
    return reduced
}

@Composable
fun DawnBackground(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier.fillMaxSize().background(StudyPalette.canvas),
        content = content,
    )
}

@Composable
fun PaperSurface(
    modifier: Modifier = Modifier,
    padding: Dp = 18.dp,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        color = StudyPalette.paper,
        border = androidx.compose.foundation.BorderStroke(.6.dp, StudyPalette.paperEdge.copy(alpha = .45f)),
    ) {
        Box(Modifier.padding(padding), contentAlignment = Alignment.CenterStart) { content() }
    }
}

@Composable
fun NoticeSurface(
    modifier: Modifier = Modifier,
    padding: Dp = 14.dp,
    content: @Composable () -> Unit,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        color = StudyPalette.paper,
        border = androidx.compose.foundation.BorderStroke(.6.dp, StudyPalette.paperEdge.copy(alpha = .45f)),
    ) {
        Box(Modifier.padding(padding), contentAlignment = Alignment.CenterStart) { content() }
    }
}

@Composable
fun PageHeading(
    eyebrow: String,
    title: String,
    subtitle: String? = null,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            Text(eyebrow, color = StudyPalette.muted,
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                letterSpacing = androidx.compose.ui.unit.TextUnit(.2f, androidx.compose.ui.unit.TextUnitType.Sp))
            Text(title, color = StudyPalette.ink,
                style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold,
                letterSpacing = androidx.compose.ui.unit.TextUnit(-.25f, androidx.compose.ui.unit.TextUnitType.Sp))
            if (subtitle != null) Text(subtitle, Modifier.padding(top = 4.dp), color = StudyPalette.muted,
                style = MaterialTheme.typography.bodySmall)
        }
        trailing?.invoke()
    }
}

@Composable
fun ConnectionFailureNotice(
    title: String,
    message: String,
    retryLabel: String = "重试",
    onRetry: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            Icons.Filled.WifiOff,
            contentDescription = null,
            tint = StudyPalette.danger,
            modifier = Modifier.padding(top = 2.dp).size(18.dp),
        )
        Column(Modifier.weight(1f).padding(start = 10.dp, end = 4.dp)) {
            Text(title, color = StudyPalette.ink, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(message, color = StudyPalette.muted, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = onRetry, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
            Text(retryLabel, color = StudyPalette.blueDeep, maxLines = 1)
        }
    }
}

@Composable
fun CompanionPortrait(modifier: Modifier = Modifier, height: Dp = 248.dp, reduceMotion: Boolean = false) {
    Box(
        modifier.fillMaxWidth().height(height).semantics { contentDescription = "伴星在书桌前陪你学习" },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painterResource(R.drawable.companion),
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier.height(height),
        )
    }
}
