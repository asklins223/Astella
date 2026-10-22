//
//  CubismBridge.mm — Astella 伴星 Live2D 渲染桥（阶段 4b）
//
//  职责：CubismFramework 初始化；单模型生命周期（moc3/model3.json → CubismUserModel）；
//  MTKView 每帧 update → draw；motion/expression 播放；口型 ParamMouthOpenY 与
//  视线（attention）参数；reduceMotion 静帧路径；资源释放。
//
//  结构参考 CubismSdkForNative-5-r.5 Samples/Metal（ViewController / LAppLive2DManager
//  的帧循环与投影拟合），但不拷其场景/触摸/精灵脚手架；模型与纹理类见同目录
//  LAppModel.* / LAppTextureManager.*（拷自该样本并适配）。
//

#import "CubismBridge.h"

#import <QuartzCore/QuartzCore.h>
#import <algorithm>

#import "CubismFramework.hpp"
#import "LAppAllocator.h"
#import "LAppDefine.h"
#import "LAppModel.h"
#import "LAppPal.h"
#import "LAppTextureManager.h"
#import "Math/CubismMatrix44.hpp"
#import "Math/CubismViewMatrix.hpp"
#import "Model/CubismModel.hpp"
#import "Rendering/Metal/CubismDeviceInfo_Metal.hpp"
#import "Rendering/Metal/CubismRenderer_Metal.hpp"

using namespace Live2D::Cubism::Framework;
using namespace Live2D::Cubism::Framework::Rendering;

namespace {

/// attention 视线目标（常规帧：drag 目标经 CubismLookUpdater 平滑趋近并回中）。
const csmFloat32 kGazeDragX = 0.6f;
const csmFloat32 kGazeDragY = 0.3f;
/// attention 视线目标（静帧：直接加算到 ParamAngleY / ParamEyeBallX）。
const csmFloat32 kGazeStaticAngleY = 10.0f;
const csmFloat32 kGazeStaticEyeBallX = 0.4f;
/// attention 偏移保持时长（秒），到期自动回中。
const CFTimeInterval kGazeHoldSeconds = 1.2;
/// 静帧表情结算步长（秒）：一次调用即越过全部 fade。
const csmFloat32 kExpressionSettleDelta = 60.0f;

} // namespace

@implementation CubismBridge {
    __weak MTKView *_view;
    id<MTLCommandQueue> _commandQueue;
    LAppTextureManager *_textureManager;
    LAppModel *_model;

    /// 待加载的模型位置（drawable 尺寸就绪后实际加载）。
    NSString *_pendingRoot;
    NSString *_pendingEntry;
    BOOL _loadFailed;

    /// 视线偏移世代号：连续 pulseAttention 时旧超时不再回中。
    NSUInteger _attentionGeneration;

    /// 视口矩阵（-1..1 屏幕矩形；与 SDK 示例同构，供未来缩放/平移使用）。
    CubismViewMatrix _viewMatrix;
}

@synthesize mouthOpen = _mouthOpen;
@synthesize reduceMotion = _reduceMotion;
@synthesize onFailure = _onFailure;

#pragma mark - Framework 初始化

+ (void)ensureFrameworkInitialized {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        static LAppAllocator allocator;
        // 注意：CubismFramework::StartUp 只保存 Option 指针，必须用静态存储。
        static CubismFramework::Option option;
        option.LogFunction = LAppPal::PrintMessageLn;
        option.LoggingLevel = LAppDefine::CubismLoggingLevel;
        option.LoadFileFunction = LAppPal::LoadFileAsBytes;
        option.ReleaseBytesFunction = LAppPal::ReleaseBytes;
        CubismFramework::StartUp(&allocator, &option);
        CubismFramework::Initialize();
    });
}

#pragma mark - 视图绑定

- (void)attachView:(MTKView *)view {
    _view = view;
    view.delegate = self;

    if (view.device == nil) {
        view.device = MTLCreateSystemDefaultDevice();
    }
    // 与 SDK Metal 示例一致：BGRA8Unorm 颜色 + Depth32Float 深度
    //（CubismShader_Metal 的管线固定声明 depthAttachmentPixelFormat = Depth32Float）。
    view.colorPixelFormat = MTLPixelFormatBGRA8Unorm;
    view.depthStencilPixelFormat = MTLPixelFormatDepth32Float;
    view.clearColor = MTLClearColorMake(0.0, 0.0, 0.0, 0.0); // 纸面上的透明底
    // MTKView 默认不透明：只把 clearColor 的 alpha 设为 0 不会透出页面纸面，
    // 整个舞台会渲染成一块黑色矩形。必须同时关掉 view/layer 的 opaque。
    view.opaque = NO;
    view.layer.opaque = NO;
    view.backgroundColor = UIColor.clearColor;
    view.preferredFramesPerSecond = 60;
    view.enableSetNeedsDisplay = NO;
    view.paused = _reduceMotion;

    if (view.device != nil) {
        if (_commandQueue == nil) {
            _commandQueue = [view.device newCommandQueue];
        }
        if (_textureManager == nil) {
            _textureManager = [[LAppTextureManager alloc] init];
        }
        _textureManager.device = view.device;
        // 模型加载前的常量设置（示例在 viewDidLoad 中调用；幂等）。
        CubismRenderer_Metal::SetConstantSettings(view.device);
    }

    if (_reduceMotion) {
        [view draw];
    }
}

- (void)detach {
    MTKView *view = _view;
    if (view != nil) {
        view.delegate = nil;
        view.paused = YES;
    }
    _view = nil;

    [self releaseModel];
    [_textureManager releaseTextures];
    _textureManager = nil;
    _commandQueue = nil;

    _pendingRoot = nil;
    _pendingEntry = nil;
    _loadFailed = NO;
    _attentionGeneration++;
}

- (void)releaseModel {
    if (_model != NULL) {
        delete _model;
        _model = NULL;
    }
    // 纹理随模型析构释放（LAppModel 析构按名归还给 textureManager）。
    CubismDeviceInfo_Metal::ReleaseAllDeviceInfo();
}

#pragma mark - 模型加载

- (void)loadModelAtRoot:(NSString *)root entry:(NSString *)entry {
    _loadFailed = NO;
    if (_model != NULL) {
        // 版本切换：先释放旧模型（设备信息在新模型首帧重建）。
        [self releaseModel];
    }
    _pendingRoot = [root copy];
    _pendingEntry = [entry copy];
    [self tryLoadPending];
}

- (void)tryLoadPending {
    if (_model != NULL || _loadFailed) {
        return;
    }
    if (_pendingRoot.length == 0 || _pendingEntry.length == 0) {
        return;
    }
    MTKView *view = _view;
    if (view == nil || view.device == nil) {
        return;
    }
    CGSize size = view.drawableSize;
    if (size.width < 1.0 || size.height < 1.0) {
        return; // drawable 尺寸就绪后由 drawInMTKView / drawableSizeWillChange: 再触发
    }

    [CubismBridge ensureFrameworkInitialized];
    CubismRenderer_Metal::SetConstantSettings(view.device);
    if (_textureManager == nil) {
        _textureManager = [[LAppTextureManager alloc] init];
    }
    _textureManager.device = view.device;

    NSString *rootPath = _pendingRoot;
    if (![rootPath hasSuffix:@"/"]) {
        rootPath = [rootPath stringByAppendingString:@"/"];
    }
    NSString *entryName = _pendingEntry;

    LAppModel *model = new LAppModel(_textureManager);
    model->LoadAssets(rootPath.UTF8String,
                      entryName.UTF8String,
                      static_cast<csmUint32>(size.width),
                      static_cast<csmUint32>(size.height));

    if (model->GetModel() == NULL) {
        delete model;
        [self reportFailure:[NSString stringWithFormat:@"Live2D 模型加载失败（%@）", entryName]];
        return;
    }

    _model = model;
    _pendingRoot = nil;
    _pendingEntry = nil;

    // 静帧模式：加载后立即渲染一次静止帧。
    if (_reduceMotion) {
        [view draw];
    }
}

- (void)reportFailure:(NSString *)message {
    if (_loadFailed) {
        return;
    }
    _loadFailed = YES;
    _pendingRoot = nil;
    _pendingEntry = nil;
    NSLog(@"[Cubism] %@", message);
    void (^onFailure)(NSString *) = self.onFailure;
    if (onFailure != nil) {
        onFailure(message);
    }
}

#pragma mark - 事件 API

- (void)setMouthOpen:(double)mouthOpen {
    _mouthOpen = mouthOpen;
    if (_model != NULL) {
        _model->SetMouthOpen(static_cast<csmFloat32>(mouthOpen));
    }
    if (_reduceMotion) {
        [self requestStaticDraw];
    }
}

- (void)setReduceMotion:(BOOL)reduceMotion {
    if (_reduceMotion == reduceMotion) {
        return;
    }
    _reduceMotion = reduceMotion;
    MTKView *view = _view;
    if (view == nil) {
        return;
    }
    if (reduceMotion) {
        // 停止每帧动画，渲染一次静止帧。
        view.enableSetNeedsDisplay = NO;
        view.paused = YES;
        [view draw];
    } else {
        view.enableSetNeedsDisplay = NO;
        view.paused = NO;
    }
}

- (void)setExpression:(NSString *)name {
    if (name.length == 0 || _model == NULL) {
        return;
    }
    _model->SetExpression(name.UTF8String);
    if (_reduceMotion) {
        [self requestStaticDraw];
    }
}

- (void)startMotionGroup:(NSString *)group {
    if (group.length == 0 || _model == NULL) {
        return;
    }
    if (_reduceMotion) {
        // reduceMotion：motion 不播放。
        return;
    }
    const csmChar *groupName = group.UTF8String;
    const csmInt32 priority = (strcmp(groupName, LAppDefine::MotionGroupIdle) == 0)
        ? LAppDefine::PriorityIdle    // Idle：低优先级，可被事件 motion 抢占；结束后自动恢复
        : LAppDefine::PriorityNormal; // 事件 motion：Normal（与另一 Normal 并发时按约定丢弃）
    _model->StartRandomMotion(groupName, priority);
}

- (void)pulseAttention {
    if (_model == NULL) {
        return;
    }
    _attentionGeneration++;
    const NSUInteger generation = _attentionGeneration;

    if (_reduceMotion) {
        _model->SetGazeOffset(kGazeStaticAngleY, kGazeStaticEyeBallX);
        [self requestStaticDraw];
    } else {
        _model->SetDragging(kGazeDragX, kGazeDragY);
    }

    __weak CubismBridge *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kGazeHoldSeconds * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        CubismBridge *strongSelf = weakSelf;
        if (strongSelf == nil || strongSelf->_attentionGeneration != generation) {
            return; // 期间又有新 pulse，由其负责回中
        }
        if (strongSelf->_model == NULL) {
            return;
        }
        if (strongSelf->_reduceMotion) {
            strongSelf->_model->SetGazeOffset(0.0f, 0.0f);
            [strongSelf requestStaticDraw];
        } else {
            strongSelf->_model->SetDragging(0.0f, 0.0f);
        }
    });
}

#pragma mark - MTKViewDelegate

- (void)mtkView:(MTKView *)view drawableSizeWillChange:(CGSize)size {
    [self tryLoadPending];
    if (_reduceMotion && _model != NULL && size.width >= 1.0 && size.height >= 1.0) {
        [view draw];
    }
}

- (void)drawInMTKView:(MTKView *)view {
    if (_model == NULL) {
        // 首帧加载竞态：MTKView 在首次 layout 时先回调 drawableSizeWillChange:，
        // 那个回调里读 view.drawableSize 仍是 0×0（尺寸尚未写回），tryLoadPending
        // 于是直接返回；之后尺寸不再变化，模型就永远不会加载，舞台一片空白。
        // drawInMTKView 拿到的 drawableSize 已经就绪，在这里补一次加载。
        [self tryLoadPending];
        if (_model == NULL) {
            return;
        }
    }
    CGSize size = view.drawableSize;
    if (size.width < 1.0 || size.height < 1.0) {
        return;
    }

    MTLRenderPassDescriptor *renderPassDescriptor = view.currentRenderPassDescriptor;
    id<CAMetalDrawable> drawable = view.currentDrawable;
    if (renderPassDescriptor == nil || drawable == nil || _commandQueue == nil) {
        return;
    }

    // MTKView 自带颜色/深度附件；这里统一成清屏（透明底）配置。
    renderPassDescriptor.colorAttachments[0].loadAction = MTLLoadActionClear;
    renderPassDescriptor.colorAttachments[0].storeAction = MTLStoreActionStore;
    renderPassDescriptor.colorAttachments[0].clearColor = view.clearColor;
    if (renderPassDescriptor.depthAttachment.texture != nil) {
        renderPassDescriptor.depthAttachment.loadAction = MTLLoadActionClear;
        renderPassDescriptor.depthAttachment.storeAction = MTLStoreActionDontCare;
        renderPassDescriptor.depthAttachment.clearDepth = 1.0;
    }

    const BOOL reduce = _reduceMotion;
    if (!reduce) {
        LAppPal::UpdateTime();
    }

    id<MTLCommandBuffer> commandBuffer = [_commandQueue commandBuffer];
    CubismDeviceInfo_Metal *deviceInfo = CubismDeviceInfo_Metal::GetDeviceInfo(view.device);
    deviceInfo->GetOffscreenManager()->BeginFrameProcess();

    CubismRenderer_Metal *renderer = _model->GetRenderer<CubismRenderer_Metal>();
    renderer->StartFrame(commandBuffer, renderPassDescriptor);
    const MTLViewport viewport = { 0.0, 0.0, size.width, size.height, 0.0, 1.0 };
    renderer->SetRenderViewport(viewport);

    // 投影：画布适配视口（沿用 SDK Metal 示例的 fit 逻辑，宽高比取 drawable）。
    const float aspectRatio = static_cast<float>(size.width / size.height);
    const float displayRatio = static_cast<float>(size.height / size.width);
    const float canvasRatio = _model->GetModel()->GetCanvasHeight()
                            / _model->GetModel()->GetCanvasWidth();
    CubismMatrix44 projection;
    if (canvasRatio < displayRatio) {
        _model->GetModelMatrix()->SetWidth(2.0f);
        projection.Scale(1.0f, aspectRatio);
    } else {
        _model->GetModelMatrix()->SetHeight(2.0f);
        projection.Scale(1.0f / aspectRatio, 1.0f);
    }
    projection.MultiplyByMatrix(&_viewMatrix);

    if (reduce) {
        _model->UpdateStatic(kExpressionSettleDelta);
    } else {
        _model->Update();
    }
    _model->Draw(projection);

    deviceInfo->GetOffscreenManager()->EndFrameProcess();
    deviceInfo->GetOffscreenManager()->ReleaseStaleRenderTextures();

    [commandBuffer presentDrawable:drawable];
    [commandBuffer commit];
}

#pragma mark - 私有

- (void)requestStaticDraw {
    MTKView *view = _view;
    if (view != nil && view.isPaused) {
        [view draw]; // paused=YES 且 enableSetNeedsDisplay=NO 时的手动单帧入口
    }
}

@end
