/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

// —— 拷自 CubismSdkForNative-5-r.5/Samples/Metal/Demo/proj.ios.cmake/src/LAppTextureManager.h（SDK r.5）。
//    Astella 适配：新增 device 属性（由 CubismBridge 注入 MTKView 的设备），移除示例 App
//    （AppDelegate/SceneDelegate/ViewController）依赖声明；与原文件的差异以本文件为准。

#ifndef LAppTextureManager_h
#define LAppTextureManager_h

#import <string>
#import <MetalKit/MetalKit.h>
#import <Type/csmVector.hpp>


@interface LAppTextureManager : NSObject

/**
 * @brief 画像情報構造体
 */
typedef struct
{
    id <MTLTexture> id;              ///< テクスチャID
    int width;              ///< 横幅
    int height;             ///< 高さ
    std::string fileName;       ///< ファイル名
}TextureInfo;

/// 纹理创建用 Metal 设备（attachView 时由桥注入）。
@property (nonatomic, strong) id<MTLDevice> device;

/**
 * @brief 初期化
 */
- (id)init;

/**
 * @brief 解放処理
 *
 */
- (void)dealloc;

/**
 * @brief 画像読み込み
 *
 * @param[in] fileName  読み込む画像ファイルパス名（絶対パス可）
 * @return 画像情報。読み込み失敗時はNULLを返す
 */
- (TextureInfo*)createTextureFromPngFile:(std::string)fileName;

/**
 * @brief 画像の解放
 *
 * 配列に存在する画像全てを解放する
 */
- (void)releaseTextures;

/**
 * @brief 画像の解放
 *
 * 指定したテクスチャIDの画像を解放する
 * @param[in] textureId  解放するテクスチャID
 **/
- (void)releaseTextureWithId:(id <MTLTexture>)textureId;

/**
 * @brief 画像の解放
 *
 * 指定した名前の画像を解放する
 * @param[in] fileName  解放する画像ファイルパス名
 **/
- (void)releaseTextureByName:(std::string)fileName;

@end
#endif /* LAppTextureManager_h */
