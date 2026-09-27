package app.archivist.tv.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Typography
import androidx.tv.material3.darkColorScheme
import app.archivist.tv.R

/** The design system's palette, as the web Player draws it. */
object Palette {
    val canvas = Color(0xFF05050A)
    val panel = Color(0xFF11121A)
    val panelRaised = Color(0xFF1A1C26)
    val text = Color(0xFFFFFFFF)
    val muted = Color(0xB3FFFFFF)
    val dim = Color(0x73FFFFFF)
    val faint = Color(0x1FFFFFFF)
    val film = Color(0xFF00D4FF)
    val series = Color(0xFF9B59B6)
    val pink = Color(0xFFFF2D78)
    val games = Color(0xFF2ECC71)
    val watched = Color(0xFF3DDC97)
    val catalogue = Color(0xFF6D8A9E)
}

/*
 * The web Player's three faces, bundled as TTF (Android does not read the
 * WOFF2 the web ships): Bebas Neue for titles and headings, DM Sans for text,
 * JetBrains Mono for labels and controls.
 */
val Display = FontFamily(Font(R.font.bebas_neue_regular, FontWeight.Normal))
val Sans = FontFamily(
    Font(R.font.dm_sans_regular, FontWeight.Normal),
    Font(R.font.dm_sans_medium, FontWeight.Medium),
    Font(R.font.dm_sans_semibold, FontWeight.SemiBold),
    Font(R.font.dm_sans_bold, FontWeight.Bold),
)
val Mono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_semibold, FontWeight.SemiBold),
)

@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
fun ArchivistTheme(content: @Composable () -> Unit) {
    val base = Typography()
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Palette.film,
            onPrimary = Palette.canvas,
            background = Palette.canvas,
            surface = Palette.panel,
            onSurface = Palette.text,
            surfaceVariant = Palette.panelRaised,
            onSurfaceVariant = Palette.muted,
            border = Palette.faint,
        ),
        // Sized for a screen across the room: a 1080p television is 960x540dp.
        // Bebas Neue sets tall and narrow, so it runs larger than a sans would.
        typography = base.copy(
            displayMedium = TextStyle(fontFamily = Display, fontSize = 60.sp, lineHeight = 60.sp, letterSpacing = 2.sp),
            headlineSmall = TextStyle(fontFamily = Display, fontSize = 26.sp, letterSpacing = 1.sp),
            titleMedium = TextStyle(fontFamily = Sans, fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
            bodyLarge = TextStyle(fontFamily = Sans, fontSize = 15.sp, lineHeight = 23.sp),
            bodyMedium = TextStyle(fontFamily = Sans, fontSize = 12.sp, lineHeight = 17.sp),
            labelLarge = TextStyle(fontFamily = Mono, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, letterSpacing = 1.2.sp),
            labelMedium = TextStyle(fontFamily = Mono, fontSize = 10.sp, letterSpacing = 1.sp),
        ),
        content = content,
    )
}
