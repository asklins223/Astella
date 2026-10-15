/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

// —— 拷自 CubismSdkForNative-5-r.5/Samples/Metal/Demo/proj.ios.cmake/src/LAppAllocator.h（SDK r.5，见 native-sdk 许可文件）。
//    Astella 适配：原样拷贝；与原文件的差异以本文件为准。

#ifndef LAppAllocator_h
#define LAppAllocator_h

#import "CubismFramework.hpp"
#import "ICubismAllocator.hpp"

/**
 * @brief メモリアロケーションを実装するクラス。
 *
 * メモリ確保・解放処理のインターフェースの実装。
 * フレームワークから呼び出される。
 *
 */
class LAppAllocator : public Csm::ICubismAllocator
{
    /**
     * @brief  メモリ領域を割り当てる。
     *
     * @param[in]   size    割り当てたいサイズ。
     * @return  指定したメモリ領域
     */
    void* Allocate(const Csm::csmSizeType size);

    /**
     * @brief   メモリ領域を解放する。
     *
     * @param[in]   memory    解放するメモリ。
     */
    void Deallocate(void* memory);

    /**
     * @brief メモリ領域の再割り当てをする。
     *
     * @param[in]   size         割り当てたいサイズ。
     * @param[in]   alignment    割り当てたいサイズ。
     * @return  alignedAddress
     */
    void* AllocateAligned(const Csm::csmSizeType size, const Csm::csmUint32 alignment);

    /**
     * @brief メモリ領域を解放する。
     *
     * @param[in]   alignedMemory    解放するメモリ。
     */
    void DeallocateAligned(void* alignedMemory);
};

#endif /* LAppAllocator_h */
