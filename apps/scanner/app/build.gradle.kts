import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Load the release signing config from apps/scanner/keystore.properties.
// That file is git-ignored; it points at the release keystore under dist/.
val keystoreProperties = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) {
        f.inputStream().use { load(it) }
    }
}
val releaseSigningKeys = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
val releaseSigningReady = releaseSigningKeys.all {
    !keystoreProperties.getProperty(it).isNullOrBlank()
} && keystoreProperties.getProperty("storeFile")?.let { rootProject.file(it).isFile } == true

android {
    namespace = "com.airferry.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.airferry.app"
        minSdk = 29          // Android 10+
        targetSdk = 34
        versionCode = 21
        versionName = "1.2.7"

        // Native build: ZXing-C++ via CMake + JNI bridge.
        externalNativeBuild {
            cmake {
                cppFlags("-std=c++20")
                arguments("-DANDROID_STL=c++_static")
            }
        }
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }

    signingConfigs {
        create("release") {
            // Read the keystore location + credentials from keystore.properties
            // (git-ignored). The keystore ships under dist/ so it stays out of
            // git while remaining alongside release artifacts. Release tasks
            // fail closed below when any credential or the keystore is absent.
            if (releaseSigningReady) {
                // Resolve the storeFile path relative to the Gradle rootProject
                // (apps/scanner/), not the module dir (app/), so the keystore
                // path in keystore.properties is relative to apps/scanner/.
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // R8 混淆 + 死代码消除：剥离 material-icons-extended 等依赖中
            // 未被引用的代码（3.2 万图标类）与资源，显著减小 APK 体积。
            isMinifyEnabled = true
            isShrinkResources = true
            // Sign only with the dedicated release keystore. The task-graph
            // guard below rejects release builds without a complete config.
            signingConfig = if (releaseSigningReady) {
                signingConfigs.getByName("release")
            } else {
                null
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    ndkVersion = "27.0.12077973"

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.14"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// ---- Native Rust JNI (libtransfer_engine.so) auto-rebuild ----
// The APK ships a Rust cdylib (`transfer_engine`) compiled via cargo-ndk
// straight into `src/main/jniLibs`. If that `.so` is stale (built from an
// older core), the Kotlin segmented-receive path calls native symbols that
// don't exist and the app hangs at "正在同步" on >32 MiB transfers — while the
// Web receiver (latest WASM) keeps working. Rebuilding the Rust JNI library on
// every APK build guarantees the packaged `.so` always matches the checked-in
// core sources, so a locally-built APK can never ship a stale native lib again.
val compileRustJni = tasks.register<Exec>("compileRustJni") {
    group = "build"
    description = "Compile the Rust transfer_engine JNI library (.so) via cargo-ndk."
    workingDir = rootProject.file("../..") // AirFerry/ workspace root
    // cargo-ndk discovers the NDK itself from ANDROID_NDK_HOME / ANDROID_HOME /
    // ANDROID_SDK_ROOT. Pass through any already-exported vars so a
    // bare `./gradlew` still finds the NDK without extra setup.
    doFirst {
        for (v in listOf("ANDROID_NDK_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT")) {
            val value = System.getenv(v)
            if (!value.isNullOrBlank()) {
                environment(v, value)
            }
        }
    }
    // Up-to-date check: skip the cargo invocation entirely when core/ sources
    // and this task's command line haven't changed since the .so was produced.
    inputs.dir(rootProject.file("../../core"))
    inputs.file(rootProject.file("../../Cargo.toml"))
    inputs.file(rootProject.file("../../Cargo.lock"))
    outputs.file(rootProject.file("app/src/main/jniLibs/arm64-v8a/libtransfer_engine.so"))
    commandLine(
        "cargo", "ndk", "-t", "arm64-v8a",
        "-o", rootProject.file("app/src/main/jniLibs").absolutePath,
        "build", "-p", "transfer-engine", "--features", "jni", "--release",
    )
}
// Run before the JNI .so is merged into the APK for either variant.
tasks.matching {
    it.name.startsWith("merge") && it.name.endsWith("JniLibFolders")
}.configureEach {
    dependsOn(compileRustJni)
}

// A release artifact must never silently fall back to the public debug key.
gradle.taskGraph.whenReady {
    val buildsRelease = allTasks.any { task ->
        task.project == project && task.name.contains("release", ignoreCase = true)
    }
    if (buildsRelease && !releaseSigningReady) {
        throw GradleException(
            "Release signing is not configured. Provide apps/scanner/keystore.properties " +
                "with storeFile/storePassword/keyAlias/keyPassword and an existing keystore."
        )
    }
}

dependencies {
    // AndroidX core
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")

    // Jetpack Compose
    val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.4")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // CameraX — real-time video stream scanning (ImageAnalysis).
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")

    // Lifecycle / ViewModel.
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.4")
    implementation("androidx.activity:activity-ktx:1.9.1")

    // Coroutines.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // JSON parsing (for JNI progress payloads).
    implementation("org.json:json:20240303")

    // Pure JVM protocol/helper tests (no device or native library required).
    testImplementation("junit:junit:4.13.2")
}
