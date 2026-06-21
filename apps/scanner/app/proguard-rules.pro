# Keep JNI native method signatures.
-keep class com.airferry.app.native.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
