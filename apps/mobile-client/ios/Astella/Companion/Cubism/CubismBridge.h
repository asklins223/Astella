//
//  CubismBridge.h — Astella 伴星 Live2D 渲染桥（阶段 4b）
//
//  ObjC++ 桥层入口（Swift 经桥接头可见）：封装 CubismFramework 初始化、单模型加载、
//  MTKView 渲染循环（每帧 update → draw）、motion/expression 播放、口型与视线参数写入、
//  reduceMotion 静帧降级与资源释放。实现见同目录 CubismBridge.mm。
//

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <MetalKit/MetalKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Cubism 渲染桥：一个实例服务一个 MTKView / 一个模型。
///
/// 生命周期（由 Live2DRenderView 的 Coordinator 驱动）：
///   attachView →（drawable 尺寸就绪后）loadModel… → 各事件 API → detach。
///
/// 加载失败会回调 `onFailure`（主线程）；Swift 侧据此把 ModelDownloadManager 置
/// `.failed`，回落 PNG 降级（保留 4a 语义）。
@interface CubismBridge : NSObject <MTKViewDelegate>

/// 渲染层失败回调（模型加载失败/初始化异常）。主线程调用，只会触发一次。
@property (nonatomic, copy, nullable) void (^onFailure)(NSString *message);

/// 口型：0…1，每帧覆写 ParamMouthOpenY（TTS 播放进度驱动；静帧模式下 setter 即重绘）。
@property (nonatomic, assign) double mouthOpen;

/// reduceMotion：开启后停止每帧动画（渲染静止帧一次），motion 不播放，
/// expression 直接置位（大步长结算）。
@property (nonatomic, assign) BOOL reduceMotion;

/// 绑定 MTKView：设备、像素格式、渲染循环、命令队列与 Metal 常量设置。
- (void)attachView:(MTKView *)view;

/// 指定模型根目录（版本目录）与 model3.json 入口。实际加载推迟到 drawable 尺寸
/// 就绪后（首次 draw 前由 mtkView:drawableSizeWillChange: 触发）；失败回调 onFailure。
- (void)loadModelAtRoot:(NSString *)root entry:(NSString *)entry;

/// 释放模型、纹理与设备信息，解绑视图（视图移出或降级时调用）。
- (void)detach;

/// 设置表情（model3.json Expressions 条目名）；nil 无效。
- (void)setExpression:(nullable NSString *)name;

/// 按 model3.json Motions 分组名随机播一条（Idle 组循环；reduceMotion 下不播放）。
- (void)startMotionGroup:(nullable NSString *)group;

/// attention 事件：视线短暂偏向（ParamAngleY/ParamEyeBallX）后自动回中（约 1.2s）。
- (void)pulseAttention;

@end

NS_ASSUME_NONNULL_END
