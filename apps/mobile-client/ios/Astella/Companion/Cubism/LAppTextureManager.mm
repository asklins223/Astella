/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

// —— 拷自 CubismSdkForNative-5-r.5/Samples/Metal/Demo/proj.ios.cmake/src/LAppTextureManager.mm（SDK r.5）。
//    Astella 适配：PNG 解码与 mip 生成改走 MTKTextureLoader（sRGB 关、mipmap 开），
//    替换原 stb_image + 手动 blit 路径；设备由 device 属性注入，移除示例 App 脚手架
//    （AppDelegate/SceneDelegate/ViewController/MetalUIView）引用；ARC 下移除
//    release/autorelease。与原文件的差异以本文件为准。

#import "LAppTextureManager.h"
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>
#import "LAppPal.h"

@interface LAppTextureManager()

@property (nonatomic) Csm::csmVector<TextureInfo*> textures;

@end

@implementation LAppTextureManager

- (id)init
{
    self = [super init];
    return self;
}

- (void)dealloc
{
    [self releaseTextures];
}

- (TextureInfo*) createTextureFromPngFile:(std::string)fileName
{
    //search loaded texture already.
    for (Csm::csmUint32 i = 0; i < _textures.GetSize(); i++)
    {
        if (_textures[i]->fileName == fileName)
        {
            return _textures[i];
        }
    }

    if (self.device == nil)
    {
        NSLog(@"[Cubism] texture device not injected yet: %s", fileName.c_str());
        return NULL;
    }

    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:fileName.c_str()]];
    if (![[NSFileManager defaultManager] fileExistsAtPath:url.path])
    {
        NSLog(@"[Cubism] texture file missing: %s", fileName.c_str());
        return NULL;
    }

    NSError *error = nil;
    MTKTextureLoader *loader = [[MTKTextureLoader alloc] initWithDevice:self.device];
    // Live2D 纹理按非 sRGB RGBA8 采样（与 SDK 示例一致），并生成 mipmap 供采样器使用。
    NSDictionary *options = @{
        MTKTextureLoaderOptionSRGB: @NO,
        MTKTextureLoaderOptionGenerateMipmaps: @YES,
        MTKTextureLoaderOptionTextureUsage: @(MTLTextureUsageShaderRead),
        MTKTextureLoaderOptionTextureStorageMode: @(MTLStorageModeShared),
    };
    id<MTLTexture> texture = [loader newTextureWithContentsOfURL:url options:options error:&error];
    if (!texture)
    {
        NSLog(@"[Cubism] texture load failed: %s (%@)", fileName.c_str(), error);
        return NULL;
    }

    TextureInfo* textureInfo = new TextureInfo;
    textureInfo->fileName = fileName;
    textureInfo->width = static_cast<int>(texture.width);
    textureInfo->height = static_cast<int>(texture.height);
    textureInfo->id = texture;
    _textures.PushBack(textureInfo);

    return textureInfo;
}

- (void)releaseTextures
{
    // 原示例在遍历中 Remove(i) 会跳元素；这里改为始终取头元素，确保全部释放。
    while (_textures.GetSize() > 0)
    {
        delete _textures[0];
        _textures.Remove(0);
    }

    _textures.Clear();
}

- (void)releaseTextureWithId:(id <MTLTexture>) textureId
{
    for (Csm::csmUint32 i = 0; i < _textures.GetSize(); i++)
    {
        if (_textures[i]->id != textureId)
        {
            continue;
        }
        delete _textures[i];
        _textures.Remove(i);
        break;
    }
}

- (void)releaseTextureByName:(std::string)fileName;
{
    for (Csm::csmUint32 i = 0; i < _textures.GetSize(); i++)
    {
        if (_textures[i]->fileName == fileName)
        {
            delete _textures[i];
            _textures.Remove(i);
            break;
        }
    }
}

@end
