import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "app.archivist.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.archivist.tv"
        // Android 5.1 — the oldest Fire TV Stick still in service runs Fire OS 5.
        minSdk = 22
        targetSdk = 35
        versionCode = 34
        versionName = "0.4.22"
    }

    signingConfigs {
        if (keystoreProperties.isNotEmpty()) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    packaging {
        // The libretro cores are loaded by path from the installed native
        // library folder, so they are extracted at install rather than mapped
        // from inside the APK.
        jniLibs { useLegacyPackaging = true }
    }

    defaultConfig {
        // Every Fire TV and Google TV device is ARM; the cores are bundled for both widths.
        ndk { abiFilters += listOf("armeabi-v7a", "arm64-v8a") }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // The web Player, kept for the sections not yet native (music, books, games).
    implementation("androidx.webkit:webkit:1.12.1")

    // Native UI: Compose, with the TV components for focus and cards.
    implementation(platform("androidx.compose:compose-bom:2025.05.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.tv:tv-material:1.0.1")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    // Playback: ExoPlayer plays the library's files directly — MKV, HEVC,
    // Dolby and DTS passthrough — and HLS for the server's fallback stream.
    implementation("androidx.media3:media3-exoplayer:1.6.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.6.1")
    implementation("androidx.media3:media3-ui:1.6.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.6.1")

    // Retro games: libretro cores run natively through LibretroDroid (GPLv3,
    // as are the cores bundled in src/main/jniLibs).
    implementation("com.github.Swordfish90:LibretroDroid:0.14.0")

    // Network and artwork.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.coil-kt.coil3:coil-compose:3.2.0")
    implementation("io.coil-kt.coil3:coil-network-okhttp:3.2.0")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub in local unit tests; this is the real one.
    testImplementation("org.json:json:20240303")
}

// The server picker is a small web page styled with Archivist's own design
// tokens and fonts, built from ../web into the APK's assets.
//
// Building it needs the Archivist monorepo (it imports the workspace's design
// system). A copy of this folder on its own — opened in Android Studio on
// another machine, say — uses the picker already built into
// src/main/assets/setup instead, so it needs no Node or pnpm at all.
val setupAssets = file("src/main/assets/setup")
val inWorkspace = rootProject.file("../../pnpm-workspace.yaml").exists() &&
    rootProject.file("../../packages/design-system").exists()

val buildSetupWeb = tasks.register<Exec>("buildSetupWeb") {
    onlyIf { inWorkspace }
    val webDir = rootProject.file("web")
    workingDir = rootProject.projectDir
    commandLine("pnpm", "run", "build:web")
    inputs.dir(webDir.resolve("src"))
    inputs.file(webDir.resolve("index.html"))
    inputs.file(webDir.resolve("vite.config.ts"))
    outputs.dir(setupAssets)
}

val checkSetupAssets = tasks.register("checkSetupAssets") {
    dependsOn(buildSetupWeb)
    doLast {
        if (!setupAssets.resolve("index.html").exists()) {
            throw GradleException(
                "The server picker is not built (app/src/main/assets/setup is empty). " +
                    "Build it inside the Archivist repo with `pnpm --filter archivist-android-tv build:web`, " +
                    "or copy that folder from a machine that has.",
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(checkSetupAssets) }
