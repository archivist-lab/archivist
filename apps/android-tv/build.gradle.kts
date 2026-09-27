plugins {
    // AGP 9 compiles Kotlin itself; there is no separate Kotlin plugin.
    id("com.android.application") version "9.4.1" apply false
    // Compose's compiler plugin, pinned to the Kotlin that AGP 9.4.1 bundles (2.2.10).
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10" apply false
}
