package com.astella.mobile.ui.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * 语义色。iOS 用系统动态语义色；Android 按 DESIGN_TOKENS §四把同一套语义承载在 M3 角色上。
 * 不使用 Material You 动态取色——方案 51 要求克制中性色 + 单一系统蓝，不跟壁纸。
 * 色值本身仍取 iOS 系统语义色的深浅两套快照，但角色归属是 M3 的，不再自持一份调色板结构。
 */
private val LightStudyScheme = lightColorScheme(
    // 单一强调色 = systemBlue(light)。业务代码只经 StudyPalette.accent 取用。
    primary = Color(0xFF5A7CD1),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE5EEFF), // primary 9% 叠在 paper 上（≈ sky）
    onPrimaryContainer = Color(0xFF5A7CD1),
    secondary = Color(0xFF5A7CD1),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE5EEFF),
    onSecondaryContainer = Color(0xFF5A7CD1),
    // 语义绿（systemGreen）放在 tertiary 槽：M3 没有 success 槽，error 槽留给 danger。
    tertiary = Color(0xFF6C9DAB),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFD8F5E2),
    onTertiaryContainer = Color(0xFF0A5B2E),
    background = Color(0xFFFFFFFF), // systemBackground
    onBackground = Color(0xFF27334B), // label
    surface = Color(0xFFFFFFFF), // secondarySystemBackground
    onSurface = Color(0xFF27334B),
    surfaceVariant = Color(0xFFF3F5F8), // tertiarySystemBackground
    onSurfaceVariant = Color(0xFF66758A), // secondaryLabel
    outline = Color(0xFFDDE2E9), // separator
    outlineVariant = Color(0xFFDDE2E9),
    error = Color(0xFFB76752), // systemRed
    onError = Color.White,
    // 中性容器族：替换 M3 baseline 的紫调默认（AlertDialog/DropdownMenu 等走这些槽）。
    surfaceDim = Color(0xFFE8E8EC),
    surfaceBright = Color(0xFFFDFDFD),
    surfaceContainerLowest = Color(0xFFFFFFFF),
    surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFF4F4F7),
    surfaceContainerHigh = Color(0xFFF3F5F8),
    surfaceContainerHighest = Color(0xFFECECF1),
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
    background = Color(0xFF101827),
    onBackground = Color(0xFFEDF2FF),
    surface = Color(0xFF1C2B43),
    onSurface = Color(0xFFEDF2FF),
    surfaceVariant = Color(0xFF283A55),
    onSurfaceVariant = Color(0xFF9AA9C2),
    outline = Color(0xFF3D5274),
    outlineVariant = Color(0xFF3D5274),
    error = Color(0xFFE5A38D),
    onError = Color.Black,
    // 中性容器族（深色），同上替换 baseline 默认。
    surfaceDim = Color(0xFF08080A),
    surfaceBright = Color(0xFF27334B),
    surfaceContainerLowest = Color(0xFF0B0B0D),
    surfaceContainerLow = Color(0xFF101827),
    surfaceContainer = Color(0xFF161619),
    surfaceContainerHigh = Color(0xFF27334B),
    surfaceContainerHighest = Color(0xFF283A55),
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
