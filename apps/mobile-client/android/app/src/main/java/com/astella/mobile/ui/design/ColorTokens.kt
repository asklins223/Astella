package com.astella.mobile.ui.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * 拾星原生色阶：雾白画布、深海墨色与单一星蓝。Android keeps Material 3
 * semantic roles while following the supplied Astella visual palette.
 */
private val LightStudyScheme = lightColorScheme(
    // 单一强调色 = systemBlue(light)。业务代码只经 StudyPalette.accent 取用。
    primary = Color(0xFF356AE8),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE8EFFF),
    onPrimaryContainer = Color(0xFF356AE8),
    secondary = Color(0xFF356AE8),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE8EFFF),
    onSecondaryContainer = Color(0xFF356AE8),
    // 语义绿（systemGreen）放在 tertiary 槽：M3 没有 success 槽，error 槽留给 danger。
    tertiary = Color(0xFF6C9DAB),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFD8F5E2),
    onTertiaryContainer = Color(0xFF0A5B2E),
    background = Color(0xFFF5F7FB),
    onBackground = Color(0xFF19283D),
    surface = Color(0xFFFCFDFF),
    onSurface = Color(0xFF19283D),
    surfaceVariant = Color(0xFFEEF2F8),
    onSurfaceVariant = Color(0xFF7B8798),
    outline = Color(0xFFDCE4F0),
    outlineVariant = Color(0xFFDCE4F0),
    error = Color(0xFFB76752), // systemRed
    onError = Color.White,
    // 中性容器族：替换 M3 baseline 的紫调默认（AlertDialog/DropdownMenu 等走这些槽）。
    surfaceDim = Color(0xFFE7ECF4),
    surfaceBright = Color(0xFFFCFDFF),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFCFDFF),
    surfaceContainer = Color(0xFFF2F5FA),
    surfaceContainerHigh = Color(0xFFEEF2F8),
    surfaceContainerHighest = Color(0xFFE7ECF4),
)

private val DarkStudyScheme = darkColorScheme(
    primary = Color(0xFFA9C2FF),
    onPrimary = Color.White,
    primaryContainer = Color(0xFF263B60),
    onPrimaryContainer = Color(0xFFA9C2FF),
    secondary = Color(0xFFA9C2FF),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF263B60),
    onSecondaryContainer = Color(0xFFA9C2FF),
    tertiary = Color(0xFFA3CDD6), // systemGreen(dark)
    onTertiary = Color(0xFF00321A),
    tertiaryContainer = Color(0xFF124A2B),
    onTertiaryContainer = Color(0xFF9DF2C4),
    background = Color(0xFF111827),
    onBackground = Color(0xFFEDF2FF),
    surface = Color(0xFF1C2B43),
    onSurface = Color(0xFFEDF2FF),
    surfaceVariant = Color(0xFF26344A),
    onSurfaceVariant = Color(0xFF9AA9C2),
    outline = Color(0xFF394B65),
    outlineVariant = Color(0xFF394B65),
    error = Color(0xFFE5A38D),
    onError = Color.Black,
    // 中性容器族（深色），同上替换 baseline 默认。
    surfaceDim = Color(0xFF0C111B),
    surfaceBright = Color(0xFF26344A),
    surfaceContainerLowest = Color(0xFF0B1019),
    surfaceContainerLow = Color(0xFF111827),
    surfaceContainer = Color(0xFF192438),
    surfaceContainerHigh = Color(0xFF202E44),
    surfaceContainerHighest = Color(0xFF26344A),
)

/**
 * 语义别名，从 [MaterialTheme.colorScheme] 派生，与 iOS `StudyPalette` 同名同义。
 * 旧名 blue / blueDeep 已合并为 accent（两者本同为 systemBlue，见 DESIGN_TOKENS §四）。
 * 业务代码只用这里的语义名，不直接写平台颜色。
 */
object StudyPalette {
    val actionFill = Color(0xFF8DB8F4)
    val night = Color(0xFF263656)
    val pollen = Color(0xFFBAD9FF)
    val ink: Color @Composable get() = MaterialTheme.colorScheme.onSurface
    val muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
    val accent: Color @Composable get() = MaterialTheme.colorScheme.primary
    val sky: Color @Composable get() = MaterialTheme.colorScheme.primaryContainer
    val canvas: Color @Composable get() = MaterialTheme.colorScheme.background
    val paper: Color @Composable get() = MaterialTheme.colorScheme.surface
    val inset: Color @Composable get() = MaterialTheme.colorScheme.surfaceVariant
    val paperEdge: Color @Composable get() = MaterialTheme.colorScheme.outline
    val success: Color @Composable get() = MaterialTheme.colorScheme.tertiary
    val danger: Color @Composable get() = MaterialTheme.colorScheme.error

    /** 设计稿底栏未选中项（比正文次级色更浅：#98a4b6）。 */
    val dockInactive = Color(0xFF98A4B6)
    /** 设计稿阅读正文色（.reader-text #29384b）。 */
    val readerInk = Color(0xFF29384B)
    /** 设计稿封面五种纸色，按手记 id 稳定取用。 */
    val coverBlue = listOf(Color(0xFF91A6C2), Color(0xFF607A9C))
    val coverSand = listOf(Color(0xFFD3C7AD), Color(0xFF9F967E))
    val coverOlive = listOf(Color(0xFF99B5AA), Color(0xFF607D77))
    val coverLilac = listOf(Color(0xFFB1ADC7), Color(0xFF79758F))
    val coverSky = listOf(Color(0xFF9BB8CA), Color(0xFF607F94))
}

/** 主题入口：色（M3 角色承载）、字阶、形状 token 一次装配。 */
@Composable
fun StudyTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkStudyScheme else LightStudyScheme,
        typography = StudyTypography,
        shapes = StudyShapes,
        content = content,
    )
}
