#include <jni.h>
#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <GLES2/gl2.h>
#include <CubismFramework.hpp>
#include <ICubismAllocator.hpp>
#include <Id/CubismIdManager.hpp>
#include <CubismModelSettingJson.hpp>
#include <Model/CubismUserModel.hpp>
#include <Rendering/OpenGL/CubismRenderer_OpenGLES2.hpp>
#include <Motion/CubismMotion.hpp>
#include <fstream>
#include <vector>
#include <string>
#include <map>
#include <mutex>
#include <cmath>
#include <cstdlib>
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#include <stb_image.h>

using namespace Live2D::Cubism::Framework;
class Allocator final : public ICubismAllocator {
public:
    void* Allocate(csmSizeType size) override { return malloc(size); }
    void Deallocate(void* ptr) override { free(ptr); }
    void* AllocateAligned(csmSizeType size, csmUint32 alignment) override {
        void* ptr = nullptr;
        return posix_memalign(&ptr, alignment < sizeof(void*) ? sizeof(void*) : alignment, size) == 0 ? ptr : nullptr;
    }
    void DeallocateAligned(void* ptr) override { free(ptr); }
};
static AAssetManager* assets = nullptr;
static csmByte* loadAsset(const std::string path, csmSizeInt* outSize) {
    if (!assets) return nullptr;
    AAsset* asset = AAssetManager_open(assets, path.c_str(), AASSET_MODE_BUFFER);
    if (!asset) return nullptr;
    const auto size = AAsset_getLength(asset);
    auto bytes = static_cast<csmByte*>(malloc(size));
    const auto count = AAsset_read(asset, bytes, size);
    AAsset_close(asset);
    if (count != size) { free(bytes); return nullptr; }
    *outSize = size; return bytes;
}
static void releaseAsset(csmByte* bytes) { free(bytes); }
static void logCubism(const char* message) { __android_log_print(ANDROID_LOG_WARN, "AstellaCubism", "%s", message); }
static Allocator allocator;
static std::once_flag initialized;
static std::vector<csmByte> readFile(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) return {};
    auto size = file.tellg();
    if (size <= 0 || size > 64 * 1024 * 1024) return {};
    std::vector<csmByte> bytes(static_cast<size_t>(size));
    file.seekg(0); file.read(reinterpret_cast<char*>(bytes.data()), size);
    return file ? bytes : std::vector<csmByte>();
}
class CompanionModel final : public CubismUserModel {
    std::vector<GLuint> textures;
    std::map<std::string, ACubismMotion*> motions;
    std::map<std::string, ACubismMotion*> expressions;
    CubismEyeBlink* blink = nullptr;
    float elapsed = 0;
    float gaze = 0;
public:
    ~CompanionModel() override {
        _motionManager->StopAllMotions();
        _expressionManager->StopAllMotions();
        for (auto& value : motions) ACubismMotion::Delete(value.second);
        for (auto& value : expressions) ACubismMotion::Delete(value.second);
        CubismEyeBlink::Delete(blink);
        if (!textures.empty()) glDeleteTextures(static_cast<GLsizei>(textures.size()), textures.data());
    }
    bool load(const std::string& root, const std::string& entry, int width, int height) {
        auto json = readFile(root + "/" + entry);
        if (json.empty()) return false;
        CubismModelSettingJson setting(json.data(), static_cast<csmSizeInt>(json.size()));
        auto parent = entry.find_last_of('/');
        std::string base = root + "/" + (parent == std::string::npos ? "" : entry.substr(0, parent + 1));
        auto moc = readFile(base + setting.GetModelFileName());
        if (moc.empty()) return false;
        LoadModel(moc.data(), static_cast<csmSizeInt>(moc.size()), true);
        if (!_model) return false;
        csmMap<csmString, csmFloat32> layout;
        setting.GetLayoutMap(layout);
        _modelMatrix->SetupFromLayout(layout);
        if (setting.GetPhysicsFileName()[0]) { auto bytes = readFile(base + setting.GetPhysicsFileName()); if (!bytes.empty()) LoadPhysics(bytes.data(), bytes.size()); }
        if (setting.GetPoseFileName()[0]) { auto bytes = readFile(base + setting.GetPoseFileName()); if (!bytes.empty()) LoadPose(bytes.data(), bytes.size()); }
        blink = CubismEyeBlink::Create(&setting);
        for (int i = 0; i < setting.GetExpressionCount(); ++i) {
            auto bytes = readFile(base + setting.GetExpressionFileName(i));
            if (!bytes.empty()) expressions[setting.GetExpressionName(i)] = LoadExpression(bytes.data(), bytes.size(), setting.GetExpressionName(i));
        }
        for (int i = 0; i < setting.GetMotionGroupCount(); ++i) {
            const char* group = setting.GetMotionGroupName(i);
            if (setting.GetMotionCount(group) < 1) continue;
            auto bytes = readFile(base + setting.GetMotionFileName(group, 0));
            if (!bytes.empty()) {
                auto motion = LoadMotion(bytes.data(), bytes.size(), group, nullptr, nullptr, &setting, group, 0);
                if (std::string(group) == "Idle") static_cast<CubismMotion*>(motion)->SetLoop(true);
                motions[group] = motion;
            }
        }
        CreateRenderer(width, height);
        auto renderer = GetRenderer<Rendering::CubismRenderer_OpenGLES2>();
        for (int i = 0; i < setting.GetTextureCount(); ++i) {
            int w, h, channels;
            auto pixels = stbi_load((base + setting.GetTextureFileName(i)).c_str(), &w, &h, &channels, 4);
            if (!pixels) return false;
            GLuint texture;
            glGenTextures(1, &texture); glBindTexture(GL_TEXTURE_2D, texture);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
            // Cubism's draw shader selects GL_LINEAR_MIPMAP_LINEAR. A base level
            // alone is incomplete on GLES and samples opaque black.
            glGenerateMipmap(GL_TEXTURE_2D);
            const auto textureError = glGetError();
            if (textureError != GL_NO_ERROR) {
                __android_log_print(ANDROID_LOG_ERROR, "AstellaCubism", "Texture %dx%d upload failed: %u", w, h, textureError);
                stbi_image_free(pixels); glDeleteTextures(1, &texture); return false;
            }
            stbi_image_free(pixels); textures.push_back(texture); renderer->BindTexture(i, texture);
        }
        renderer->IsPremultipliedAlpha(false);
        _model->SaveParameters();
        return true;
    }
    void event(int kind) {
        if (kind == 4) gaze = .65f;
        const char* expression = kind == 1 ? "surprised" : kind == 3 ? "question" : nullptr;
        if (expression && expressions.count(expression)) _expressionManager->StartMotion(expressions[expression], false);
        const char* motion = kind == 1 ? "Spray" : kind == 2 ? "Bubble" : nullptr;
        if (motion && motions.count(motion)) _motionManager->StartMotionPriority(motions[motion], false, 2);
    }
    void frame(int width, int height, float delta, float mouth, bool reduced) {
        if (!_model) return;
        _model->LoadParameters();
        if (!reduced) {
            elapsed += delta;
            if (_motionManager->IsFinished() && motions.count("Idle")) _motionManager->StartMotionPriority(motions["Idle"], false, 1);
            _motionManager->UpdateMotion(_model, delta);
            _model->SaveParameters();
            if (blink) blink->UpdateParameters(_model, delta);
            _expressionManager->UpdateMotion(_model, delta);
            if (_physics) _physics->Evaluate(_model, delta);
            if (_pose) _pose->UpdateParameters(_model, delta);
        } else { _expressionManager->UpdateMotion(_model, 100); }
        if (!reduced && gaze > 0) {
            gaze = fmaxf(0, gaze - delta);
            _model->AddParameterValue(CubismFramework::GetIdManager()->GetId("ParamEyeBallX"), gaze * .2f);
            _model->AddParameterValue(CubismFramework::GetIdManager()->GetId("ParamAngleY"), gaze * 8);
        }
        _model->SetParameterValue(CubismFramework::GetIdManager()->GetId("ParamMouthOpenY"), reduced ? 0 : mouth);
        _model->Update();
        CubismMatrix44 projection;
        const float aspect = static_cast<float>(width) / height;
        const float canvasRatio = _model->GetCanvasHeight() / _model->GetCanvasWidth();
        if (canvasRatio < 1.0f / aspect) { _modelMatrix->SetWidth(2.0f); projection.Scale(1, aspect); }
        else { _modelMatrix->SetHeight(2.0f); projection.Scale(1.0f / aspect, 1); }
        projection.MultiplyByMatrix(_modelMatrix);
        auto renderer = GetRenderer<Rendering::CubismRenderer_OpenGLES2>();
        renderer->SetMvpMatrix(&projection);
        renderer->DrawModel();
    }
};
struct Stage { CompanionModel* model = nullptr; int width = 1, height = 1; };
extern "C" JNIEXPORT jlong JNICALL Java_com_astella_mobile_companion_NativeCompanion_create(JNIEnv* env, jobject, jobject manager) {
    assets = AAssetManager_fromJava(env, manager);
    std::call_once(initialized, [] { static CubismFramework::Option option;
        option.LoadFileFunction = loadAsset; option.ReleaseBytesFunction = releaseAsset; option.LogFunction = logCubism;
        CubismFramework::StartUp(&allocator, &option); CubismFramework::Initialize(); });
    return reinterpret_cast<jlong>(new Stage());
}
extern "C" JNIEXPORT jboolean JNICALL Java_com_astella_mobile_companion_NativeCompanion_load(JNIEnv* env, jobject, jlong handle, jstring root, jstring entry) {
    auto stage = reinterpret_cast<Stage*>(handle);
    const char* directory = env->GetStringUTFChars(root, nullptr);
    const char* file = env->GetStringUTFChars(entry, nullptr);
    delete stage->model; stage->model = new CompanionModel();
    bool ok = stage->model->load(directory, file, stage->width, stage->height);
    env->ReleaseStringUTFChars(root, directory); env->ReleaseStringUTFChars(entry, file);
    if (!ok) { delete stage->model; stage->model = nullptr; }
    return ok;
}
extern "C" JNIEXPORT void JNICALL Java_com_astella_mobile_companion_NativeCompanion_resize(JNIEnv*, jobject, jlong handle, jint width, jint height) {
    auto stage = reinterpret_cast<Stage*>(handle); stage->width = width; stage->height = height;
}
extern "C" JNIEXPORT void JNICALL Java_com_astella_mobile_companion_NativeCompanion_draw(JNIEnv*, jobject, jlong handle, jfloat delta, jfloat mouth, jboolean reduced, jint event) {
    auto stage = reinterpret_cast<Stage*>(handle);
    glViewport(0, 0, stage->width, stage->height); glClearColor(0, 0, 0, 0); glClear(GL_COLOR_BUFFER_BIT);
    if (stage->model) { if (event) stage->model->event(event); stage->model->frame(stage->width, stage->height, delta, mouth, reduced); }
}
extern "C" JNIEXPORT void JNICALL Java_com_astella_mobile_companion_NativeCompanion_destroy(JNIEnv*, jobject, jlong handle) {
    auto stage = reinterpret_cast<Stage*>(handle); delete stage->model; delete stage;
}
