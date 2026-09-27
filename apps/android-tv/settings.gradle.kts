pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // LibretroDroid, the libretro frontend the retro games run on, is published there only.
        maven("https://jitpack.io") { content { includeGroup("com.github.Swordfish90") } }
    }
}

rootProject.name = "archivist-android-tv"
include(":app")
