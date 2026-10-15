/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

// —— 拷自 CubismSdkForNative-5-r.5/Samples/Metal/Demo/proj.ios.cmake/src/LAppModel.h（SDK r.5）。
//    Astella 适配：构造注入 LAppTextureManager（原示例从 AppDelegate 单例取）；LoadAssets/
//    ReloadRenderer 显式接收渲染尺寸（原示例取 ViewController 视图尺寸）；Update 拆出
//    UpdateStatic 供 reduceMotion 静帧路径（无 motion/呼吸/眨眼，表情直接结算）；新增
//    口型（ParamMouthOpenY 覆写）与视线加算偏移（ParamAngleY/ParamEyeBallX）写入口；
//    Idle 组 motion 在预载时开循环。与原文件的差异以本文件为准。

#ifndef LAppModel_h
#define LAppModel_h

#import <CubismFramework.hpp>
#import <Model/CubismUserModel.hpp>
#import <ICubismModelSetting.hpp>
#import <Type/csmRectF.hpp>
#import <Rendering/Metal/CubismRenderTarget_Metal.hpp>

@class LAppTextureManager;

/**
 * @brief ユーザーが実際に使用するモデルの実装クラス<br>
 *         モデル生成、機能コンポーネント生成、更新処理とレンダリングの呼び出しを行う。
 *
 */
class LAppModel : public Csm::CubismUserModel
{
public:
    /**
     * @brief コンストラクタ
     *
     * @param[in] textureManager 纹理管理器（桥注入；模型纹理由它加载与释放）
     */
    explicit LAppModel(LAppTextureManager* textureManager);

    /**
     * @brief デストラクタ
     *
     */
    virtual ~LAppModel();

    /**
     * @brief model3.jsonが置かれたディレクトリとファイルパスからモデルを生成する
     *
     * @param[in] dir 模型目录（绝对路径，含尾部 /）
     * @param[in] fileName model3.json 文件名
     * @param[in] renderWidth 渲染目标宽（像素），用于 CreateRenderer 的遮罩缓冲初值
     * @param[in] renderHeight 渲染目标高（像素）
     */
    void LoadAssets(const Csm::csmChar* dir, const Csm::csmChar* fileName, Csm::csmUint32 renderWidth, Csm::csmUint32 renderHeight);

    /**
     * @brief レンダラを再構築する
     */
    void ReloadRenderer(Csm::csmUint32 renderWidth, Csm::csmUint32 renderHeight);

    /**
     * @brief   モデルの更新処理（常规帧）：motion / 表情 / 呼吸 / 眨眼 / 物理全开。
     *          时间推进走 LAppPal::UpdateTime()（reduceMotion 下桥不调用它）。
     */
    void Update();

    /**
     * @brief   reduceMotion 静帧更新：不播放 motion、不跑呼吸/眨眼/物理调度，
     *          表情按 settleDelta（大步长）直接结算到位，随后应用口型与视线偏移。
     *
     * @param[in] expressionSettleDelta 表情淡入结算步长（秒）
     */
    void UpdateStatic(Csm::csmFloat32 expressionSettleDelta);

    /**
     * @brief   モデルを描画する処理。モデルを描画する空間のView-Projection行列を渡す。
     *
     * @param[in]  matrix  View-Projection行列
     */
    void Draw(Csm::CubismMatrix44& matrix);

    /**
     * @brief   引数で指定したモーションの再生を開始する。
     */
    Csm::CubismMotionQueueEntryHandle StartMotion(const Csm::csmChar* group, Csm::csmInt32 no, Csm::csmInt32 priority, Csm::ACubismMotion::FinishedMotionCallback onFinishedMotionHandler = NULL, Csm::ACubismMotion::BeganMotionCallback onBeganMotionHandler = NULL);

    /**
     * @brief   ランダムに選ばれたモーションの再生を開始する。
     */
    Csm::CubismMotionQueueEntryHandle StartRandomMotion(const Csm::csmChar* group, Csm::csmInt32 priority, Csm::ACubismMotion::FinishedMotionCallback onFinishedMotionHandler = NULL, Csm::ACubismMotion::BeganMotionCallback onBeganMotionHandler = NULL);

    /**
     * @brief   表情モーションをセットする
     *
     * @param   expressionID    表情モーションのID
     */
    void SetExpression(const Csm::csmChar* expressionID);

    /**
     * @brief   ランダムに選ばれた表情モーションをセットする
     */
    void SetRandomExpression();

    /**
     * @brief 口型写入（0…1 → ParamMouthOpenY，每帧在 motion 更新后覆写）。
     */
    void SetMouthOpen(Csm::csmFloat32 value);

    /**
     * @brief 视线加算偏移（度/归一化；UpdateStatic 静帧路径使用，常规帧由
     *        CubismLookUpdater 经 SetDragging 驱动）。
     */
    void SetGazeOffset(Csm::csmFloat32 angleY, Csm::csmFloat32 eyeBallX);

    /**
     * @brief イベントの発火を受け取る
     */
    virtual void MotionEventFired(const Live2D::Cubism::Framework::csmString& eventValue);

    /**
     * @brief    当たり判定テスト。
     */
    virtual Csm::csmBool HitTest(const Csm::csmChar* hitAreaName, Csm::csmFloat32 x, Csm::csmFloat32 y);

    /**
     * @brief 別ターゲットに描画する際に使用するバッファの取得
     */
    Csm::Rendering::CubismRenderTarget_Metal& GetRenderBuffer();

    /**
     * @brief   .moc3ファイルの整合性をチェックする
     */
    Csm::csmBool HasMocConsistencyFromFile(const Csm::csmChar* mocName);

protected:
    /**
     * @brief  モデルを描画する処理。
     */
    void DoDraw();

private:
    /**
     * @brief model3.jsonからモデルを生成する。
     */
    void SetupModel(Csm::ICubismModelSetting* setting);

    /**
     * @brief Metalテクスチャにテクスチャをロードする
     */
    void SetupTextures();

    /**
     * @brief   モーションデータをグループ名から一括でロードする。
     */
    void PreloadMotionGroup(const Csm::csmChar* group);

    /**
     * @brief   モーションデータをグループ名から一括で解放する。
     */
    void ReleaseMotionGroup(const Csm::csmChar* group) const;

    /**
     * @brief すべてのモーションデータの解放
     */
    void ReleaseMotions();

    /**
     * @brief すべての表情データの解放
     */
    void ReleaseExpressions();

    /**
     * @brief motion 更新之后写入口型与静帧视线偏移（在 _model->Update() 之前调用）。
     */
    void ApplyBlendOverrides();

    Csm::ICubismModelSetting* _modelSetting; ///< モデルセッティング情報
    Csm::csmString _modelHomeDir; ///< モデルセッティングが置かれたディレクトリ
    Csm::csmFloat32 _userTimeSeconds; ///< デルタ時間の積算値[秒]
    Csm::csmVector<Csm::CubismIdHandle> _eyeBlinkIds; ///< モデルに設定されたまばたき機能用パラメータID
    Csm::csmVector<Csm::CubismIdHandle> _lipSyncIds; ///< モデルに設定されたリップシンク機能用パラメータID
    Csm::csmMap<Csm::csmString, Csm::ACubismMotion*>   _motions; ///< 読み込まれているモーションのリスト
    Csm::csmMap<Csm::csmString, Csm::ACubismMotion*>   _expressions; ///< 読み込まれている表情のリスト
    Csm::csmVector<Csm::csmRectF> _hitArea;
    Csm::csmVector<Csm::csmRectF> _userArea;
    const Csm::CubismId* _idParamAngleX; ///< パラメータID: ParamAngleX
    const Csm::CubismId* _idParamAngleY; ///< パラメータID: ParamAngleY
    const Csm::CubismId* _idParamAngleZ; ///< パラメータID: ParamAngleZ
    const Csm::CubismId* _idParamBodyAngleX; ///< パラメータID: ParamBodyAngleX
    const Csm::CubismId* _idParamEyeBallX; ///< パラメータID: ParamEyeBallX
    const Csm::CubismId* _idParamEyeBallY; ///< パラメータID: ParamEyeBallY
    const Csm::CubismId* _idParamMouthOpenY; ///< パラメータID: ParamMouthOpenY
    Csm::csmBool _motionUpdated; ///< モーション更新フラグ

    /// 口型目标值（0…1，由 CubismBridge 每帧覆写 ParamMouthOpenY）。
    Csm::csmFloat32 _mouthOpen;
    /// 静帧视线偏移（AddParameterValue；常规帧为 0，由 LookUpdater 接管）。
    Csm::csmFloat32 _gazeOffsetAngleY;
    Csm::csmFloat32 _gazeOffsetEyeBallX;
    /// 纹理管理器（ARC strong；模型生命周期内持有）。
    LAppTextureManager* _textureManager;
    /// CreateRenderer 使用的渲染尺寸（像素）。
    Csm::csmUint32 _renderWidth;
    Csm::csmUint32 _renderHeight;

    Live2D::Cubism::Framework::Rendering::CubismRenderTarget_Metal _renderBuffer;
};

#endif /* LAppModel_h */
