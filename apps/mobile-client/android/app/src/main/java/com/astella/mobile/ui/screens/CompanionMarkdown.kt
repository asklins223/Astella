package com.astella.mobile.ui.screens

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/**
 * 轻量 Markdown：只覆盖对话里真实出现的行内 **粗体**、*斜体*、`代码`、
 * 标题与列表，避免把星号直接摊在气泡里。复杂排版仍由块级渲染负责。
 *
 * [baseFontSize] 给出时，标题按级别放大（1.18/1.10/1.04），列表缩进两个空格，
 * 让“小标题—正文—列表”在对话里也有字阶，而不是同一号的粗体。
 */
fun companionMarkdown(text: String, baseFontSize: TextUnit? = null): AnnotatedString = buildAnnotatedString {
    text.lines().forEachIndexed { index, raw ->
        if (index > 0) append('\n')
        val trimmed = raw.trimStart()
        if (trimmed.startsWith("###") || trimmed.startsWith("##") || trimmed.startsWith("#")) {
            val level = trimmed.takeWhile { it == '#' }.length.coerceIn(1, 3)
            val line = trimmed.drop(level).trimStart()
            val scale = when (level) { 1 -> 1.18f; 2 -> 1.10f; else -> 1.04f }
            pushStyle(
                SpanStyle(
                    fontWeight = FontWeight.SemiBold,
                    fontSize = baseFontSize?.let { (it.value * scale).sp } ?: TextUnit.Unspecified,
                ),
            )
            appendInline(line)
            pop()
        } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ") || trimmed.startsWith("• ")) {
            append("  • ")
            appendInline(trimmed.drop(2))
        } else {
            appendInline(raw)
        }
    }
}

private fun AnnotatedString.Builder.appendInline(input: String) {
    var i = 0
    while (i < input.length) {
        when {
            input.startsWith("**", i) || input.startsWith("__", i) -> {
                val marker = input.substring(i, i + 2)
                val end = input.indexOf(marker, i + 2)
                if (end > i + 2) {
                    pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                    appendInlinePlain(input.substring(i + 2, end))
                    pop()
                    i = end + 2
                } else { append(input[i]); i += 1 }
            }
            input[i] == '`' -> {
                val end = input.indexOf('`', i + 1)
                if (end > i + 1) {
                    pushStyle(SpanStyle(fontFamily = FontFamily.Monospace))
                    append(input.substring(i + 1, end))
                    pop()
                    i = end + 1
                } else { append(input[i]); i += 1 }
            }
            input.startsWith("*", i) || input.startsWith("_", i) -> {
                val marker = input[i]
                val end = input.indexOf(marker, i + 1)
                val next = input.getOrNull(i + 1)
                if (end > i + 1 && next != null && !next.isWhitespace()) {
                    pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                    appendInlinePlain(input.substring(i + 1, end))
                    pop()
                    i = end + 1
                } else { append(input[i]); i += 1 }
            }
            else -> { append(input[i]); i += 1 }
        }
    }
}

private fun AnnotatedString.Builder.appendInlinePlain(value: String) {
    var i = 0
    while (i < value.length) {
        when {
            value.startsWith("**", i) || value.startsWith("__", i) -> {
                val marker = value.substring(i, i + 2)
                val end = value.indexOf(marker, i + 2)
                if (end > i + 2) {
                    pushStyle(SpanStyle(fontWeight = FontWeight.SemiBold))
                    appendInlinePlain(value.substring(i + 2, end))
                    pop()
                    i = end + 2
                } else { append(value[i]); i += 1 }
            }
            value[i] == '`' -> {
                val end = value.indexOf('`', i + 1)
                if (end > i + 1) {
                    pushStyle(SpanStyle(fontFamily = FontFamily.Monospace))
                    append(value.substring(i + 1, end))
                    pop()
                    i = end + 1
                } else { append(value[i]); i += 1 }
            }
            else -> { append(value[i]); i += 1 }
        }
    }
}

@Composable
fun CompanionMarkdownText(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = androidx.compose.material3.MaterialTheme.colorScheme.onSurface,
    fontSize: TextUnit? = null,
    lineHeight: TextUnit? = null,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
) {
    Text(
        companionMarkdown(text, baseFontSize = fontSize),
        modifier,
        color = color,
        fontSize = fontSize ?: TextUnit.Unspecified,
        lineHeight = lineHeight ?: TextUnit.Unspecified,
        maxLines = maxLines,
        overflow = overflow,
    )
}
