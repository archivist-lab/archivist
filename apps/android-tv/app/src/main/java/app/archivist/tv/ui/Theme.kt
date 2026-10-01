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
 * One family throughout: Bebas Neue Pro. Bold for titles and headings,
 * Regular for labels, controls and emphasised text, Book for reading text —
 * and Book is the only one that shows lowercase.
 *
 * The Bold and Regular files here are capitals-only copies of Pro's, made the
 * way the original Bebas Neue was: each lowercase letter (accented ones too)
 * drawn with its capital. So any text set in them reads in caps without its
 * call site having to uppercase it. Made from the Pro TTFs with fontTools, by
 * pointing the cmap's lowercase code points at the uppercase glyphs.
 */
val Display = FontFamily(Font(R.font.bebas_neue_pro_bold_caps, FontWeight.Normal))
val Body = FontFamily(
    Font(R.font.bebas_neue_pro_book, FontWeight.Normal),
    Font(R.font.bebas_neue_pro_book, FontWeight.Medium),
    Font(R.font.bebas_neue_pro_regular_caps, FontWeight.SemiBold),
    Font(R.font.bebas_neue_pro_regular_caps, FontWeight.Bold),
)
val Label = FontFamily(Font(R.font.bebas_neue_pro_regular_caps, FontWeight.Normal), Font(R.font.bebas_neue_pro_regular_caps, FontWeight.SemiBold))

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
            titleMedium = TextStyle(fontFamily = Body, fontWeight = FontWeight.SemiBold, fontSize = 17.sp),
            bodyLarge = TextStyle(fontFamily = Body, fontSize = 15.sp, lineHeight = 23.sp),
            bodyMedium = TextStyle(fontFamily = Body, fontSize = 12.sp, lineHeight = 17.sp),
            labelLarge = TextStyle(fontFamily = Label, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, letterSpacing = 1.2.sp),
            labelMedium = TextStyle(fontFamily = Label, fontSize = 10.sp, letterSpacing = 1.sp),
        ),
        content = content,
    )
}
