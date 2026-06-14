# Keep JNI native method signatures.
-keep class com.easytransfer.app.native.** { *; }
-keepclasseswithmembernames class * {
    native <methods>;
}
