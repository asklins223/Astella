plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.astella.mobile"
    compileSdk = 37
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = "com.astella.mobile"
        minSdk = 28
        targetSdk = 36
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        externalNativeBuild { cmake { cppFlags += "-std=c++17" } }
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "API_ORIGIN", "\"http://10.0.2.2:4000\"")
    }

    sourceSets.getByName("main").assets.srcDir("../../native-sdk/CubismSdkForNative-5-r.5/Framework/src/Rendering/OpenGL/Shaders/StandardES")

    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }

    buildTypes {
        getByName("debug") {
            val origin = providers.gradleProperty("mobileApiOrigin").orNull ?: "http://10.0.2.2:4000"
            buildConfigField("String", "API_ORIGIN", "\"$origin\"")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.08.00")
    implementation(composeBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:5.3.0")
    implementation("com.tom-roush:pdfbox-android:2.0.27.0")
    implementation("dev.chrisbanes.haze:haze-blur:2.0.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
