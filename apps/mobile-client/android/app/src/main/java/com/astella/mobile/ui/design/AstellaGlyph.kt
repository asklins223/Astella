package com.astella.mobile.ui.design

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin

/** Product glyphs shared by the native mobile chrome. */
enum class AstellaGlyphKind(val pathData: String, val filled: Boolean = false) {
    Companion("M12 2.2c1.3 5.6 4.2 8.5 9.8 9.8-5.6 1.3-8.5 4.2-9.8 9.8C10.7 16.2 7.8 13.3 2.2 12 7.8 10.7 10.7 7.8 12 2.2Z", true),
    Library("M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5z M8 3v17 M12 7h4v6h-4z"),
    Orbit("M12 3.2 14.2 9.8 21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z M19 3.5v.1 M5 19v.1 M20 18l.1.1", true),
    Hand("M3.5 7.5h17v12h-17z M7.5 12.5l2.5 3h4l2.5-3"),
    Book("M4 5.5A2.5 2.5 0 0 1 6.5 3H19v17H6.5A2.5 2.5 0 0 1 4 17.5z M8 3v17 M11 7h5 M11 10h5", false),
    Search("M10.5 2.5a8 8 0 1 0 4.65 14.5l4.95 4.95a1.35 1.35 0 0 0 1.9-1.9l-4.95-4.95A8 8 0 0 0 10.5 2.5Zm0 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z", true),
    Add("M12 4v16 M4 12h16"),
    Back("M15 4 7 12l8 8"),
    Chevron("M9 5l7 7-7 7"),
    Close("M6 6l12 12 M18 6 6 18"),
    Person("M12 3.2a4.1 4.1 0 1 0 0 8.2 4.1 4.1 0 0 0 0-8.2ZM3.5 21v-2a8.5 8.5 0 0 1 17 0v2z", true),
    Mic("M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5.5 10.5a6.5 6.5 0 0 0 13 0 M12 17v4 M9 21h6"),
    Send("M12 2.8 21.3 20a1 1 0 0 1-1.2 1.4L12 18l-8.1 3.4A1 1 0 0 1 2.7 20z M12 18V9", true),
    Moon("M20.5 14a9.6 9.6 0 0 1-11-11A9.6 9.6 0 1 0 20.5 14Z", true),
    Sun("M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M18.4 5.6 17 7 M7 17l-1.4 1.4 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"),
    Document("M6 3.5h8l4 4V20H6z M14 3.5v4h4 M9 12h6 M9 16h6"),
    Refresh("M20 7v5h-5 M19 12a7 7 0 1 1-2-5"),
    More("M5 12h.1 M12 12h.1 M19 12h.1"),
    Grid("M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z"),
    Alert("M12 8v5 M12 17.5h.1 M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Z"),
    Check("M5 12.5 9.2 16.5 19 6.8"),
    Settings("M3 6h18 M3 12h18 M3 18h18 M8 4v4 M15 10v4 M10 16v4"),
    Mail("M3 5h18v14H3z M4 7l8 6 8-6"),
    Lock("M6 10h12v11H6z M8.5 10V7a3.5 3.5 0 0 1 7 0v3 M12 14v3"),
    Key("M14 9a5 5 0 1 1-10 0 5 5 0 0 1 10 0z M14 9h7l-2 2 2 2h-4"),
    Eye("M2 12c2.4-4.3 5.8-6.5 10-6.5s7.6 2.2 10 6.5c-2.4 4.3-5.8 6.5-10 6.5S4.4 16.3 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"),
    EyeSlash("M2 12c2.4-4.3 5.8-6.5 10-6.5s7.6 2.2 10 6.5c-2.4 4.3-5.8 6.5-10 6.5S4.4 16.3 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z M3 3l18 18"),
    History("M3 11a9 9 0 1 1 2.1 6 M3 4v7h7 M12 7v5l3.5 2"),
    Chat("M4 4h16v13H9l-5 4z M8 9h8 M8 12h5"),
    Logout("M5 3h8v18H5z M11 12h10 M21 12l-4-4 M21 12l-4 4"),
    Shield("M12 3 20 6v5c0 5-3.3 8.2-8 10-4.7-1.8-8-5-8-10V6z M8.5 12l2.3 2.3 4.8-5"),
    Copy("M8 8h12v13H8z M4 16V3h12v5"),
    Speaker("M3 9v6h4l6 5V4L7 9H3z M16 9a4 4 0 0 1 0 6 M18 6a8 8 0 0 1 0 12"),
    Number("M7 4 4 20 M16 4l-3 16 M3 9h18 M2 15h18"),
    Photo("M4 5h16v14H4z M5 16l4-5 3 3 3-4 4 6 M8 9h.1"),
    Play("M7 4 20 12 7 20z", true),
    Pause("M5 4h5v16H5z M14 4h5v16h-5z", true),
    Stop("M5 5h14v14H5z", true),
    Wave("M4 10v4 M8 7v10 M12 4v16 M16 7v10 M20 10v4"),
    Download("M12 3v12 M7 10l5 5 5-5 M4.5 20h15"),
    Edit("M4 20l4.2-1 10.6-10.6-3.2-3.2L5 15.8z M14.6 6.2l3.2 3.2"),
    Camera("M4 8h4l2-3h4l2 3h4v12H4z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"),
    Bell("M6 17V11a6 6 0 0 1 12 0v6l2 2H4z M10 21h4"),
    Clock("M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M12 8v4.6l3 1.8"),
    Info("M12 10.5v7 M12 6.6h.1 M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19Z"),
    Quote("M5 6h14 M5 12h14 M5 18h8"),
}

@Composable
fun AstellaGlyph(
    kind: AstellaGlyphKind,
    modifier: Modifier = Modifier,
    tint: Color = StudyPalette.ink,
    strokeWidth: Float = 1.8f,
) {
    val path: Path = remember(kind) {
        PathParser().parsePathString(kind.pathData).toPath()
    }
    Canvas(modifier) {
        withTransform({ scale(size.width / 24f, size.height / 24f, Offset.Zero) }) {
            drawPath(
                path = path,
                color = tint,
                style = if (kind.filled) Fill else Stroke(
                    width = strokeWidth,
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                ),
            )
        }
    }
}
