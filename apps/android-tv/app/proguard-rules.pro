# The page calls these by name through addJavascriptInterface.
-keepclassmembers class app.archivist.tv.ShellBridge {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface

# LibretroDroid's native side calls back into its Kotlin classes by name (JNI),
# and the library ships no keep rules of its own: kept whole, as Lemuroid does.
-keep class com.swordfish.libretrodroid.** { *; }
