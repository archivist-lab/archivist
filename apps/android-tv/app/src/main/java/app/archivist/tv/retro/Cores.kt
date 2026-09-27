package app.archivist.tv.retro

/**
 * The libretro core for each of the arcade's systems, bundled in the APK
 * (src/main/jniLibs) because Android will not run native code the app
 * downloads for itself. Keyed by the web Player's EmulatorJS core names, which
 * are what the server reports.
 */
object Cores {
    private val BY_EJS_CORE = mapOf(
        "nes" to "fceumm",
        "snes" to "snes9x",
        "gb" to "gambatte",
        "segaMS" to "genesis_plus_gx",
        "segaMD" to "genesis_plus_gx",
        "n64" to "mupen64plus_next_gles3",
        "psx" to "pcsx_rearmed",
        "segaSaturn" to "yabasanshiro",
    )

    /** The core's library file name, or null for a system this app has no core for. */
    fun libraryFor(ejsCore: String): String? = BY_EJS_CORE[ejsCore]?.let { "lib${it}_libretro_android.so" }
}
