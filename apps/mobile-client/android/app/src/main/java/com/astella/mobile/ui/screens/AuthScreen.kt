package com.astella.mobile.ui.screens

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import com.astella.mobile.R
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.ui.design.*
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import kotlinx.coroutines.delay

@Composable
fun LoginScreen(state: AppUiState, viewModel: AppViewModel) {
    StudyTheme(darkTheme = false) { AuthenticationScreen(state, viewModel) }
}

@Composable
private fun AuthenticationScreen(state: AppUiState, viewModel: AppViewModel) {
    val activity = LocalContext.current as? Activity
    val view = LocalView.current
    DisposableEffect(view) {
        val bars = activity?.let { WindowCompat.getInsetsController(it.window, view) }
        val oldStatus = bars?.isAppearanceLightStatusBars
        val oldNavigation = bars?.isAppearanceLightNavigationBars
        bars?.isAppearanceLightStatusBars = true
        bars?.isAppearanceLightNavigationBars = true
        onDispose {
            if (oldStatus != null) bars.isAppearanceLightStatusBars = oldStatus
            if (oldNavigation != null) bars.isAppearanceLightNavigationBars = oldNavigation
        }
    }
    val reduceMotion = state.localReduceMotion || com.astella.mobile.ui.design.rememberSystemReducedMotion()
    var route by rememberSaveable { mutableStateOf(MobileAuthRoute.Login) }
    var navigatingBack by remember { mutableStateOf(false) }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmPassword by remember { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var inviteToken by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var showInviteField by rememberSaveable { mutableStateOf(false) }
    var resendIn by rememberSaveable { mutableStateOf(0) }
    val keyboardController = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    val focusManager = androidx.compose.ui.platform.LocalFocusManager.current
    val normalizedEmail = email.trim()
    val validEmail = android.util.Patterns.EMAIL_ADDRESS.matcher(normalizedEmail).matches()
    val validCode = code.length == 6 && code.all(Char::isDigit)
    val passwordReady = password.length in 8..200
    val confirmMatches = confirmPassword.isNotEmpty() && confirmPassword == password

    LaunchedEffect(resendIn) {
        if (resendIn > 0) {
            delay(1_000)
            resendIn = (resendIn - 1).coerceAtLeast(0)
        }
    }

    fun clearFeedback() = viewModel.clearAuthFeedback()
    fun navigate(target: MobileAuthRoute, preserveNotice: Boolean = false) {
        if (state.isLoading || target == route) return
        focusManager.clearFocus()
        keyboardController?.hide()
        if (!preserveNotice) clearFeedback()
        navigatingBack = target.depth < route.depth
        route = target
    }
    fun goBack() {
        if (route in setOf(MobileAuthRoute.RegisterCode, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode)) {
            code = ""
            resendIn = 0
        }
        when (route) {
            MobileAuthRoute.Register -> navigate(MobileAuthRoute.Login)
            MobileAuthRoute.RegisterPassword -> navigate(MobileAuthRoute.Register)
            MobileAuthRoute.RegisterCode -> navigate(MobileAuthRoute.RegisterPassword)
            MobileAuthRoute.Forgot -> navigate(MobileAuthRoute.Login)
            MobileAuthRoute.Reset -> navigate(MobileAuthRoute.Forgot)
            MobileAuthRoute.ResetPassword -> navigate(MobileAuthRoute.Reset)
            MobileAuthRoute.EmailLogin -> navigate(MobileAuthRoute.Login)
            MobileAuthRoute.EmailLoginCode -> navigate(MobileAuthRoute.EmailLogin)
            MobileAuthRoute.Login -> Unit
        }
    }
    fun sendCode(purpose: String, destination: MobileAuthRoute) {
        focusManager.clearFocus()
        keyboardController?.hide()
        viewModel.sendEmailCode(normalizedEmail, purpose) { seconds ->
            keyboardController?.hide()
            code = ""
            resendIn = seconds
            navigatingBack = destination.depth < route.depth
            route = destination
        }
    }
    fun canContinue(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> validEmail && password.isNotEmpty()
        MobileAuthRoute.Register -> validEmail
        MobileAuthRoute.RegisterPassword, MobileAuthRoute.ResetPassword -> passwordReady && confirmMatches
        MobileAuthRoute.RegisterCode, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode -> validCode
        MobileAuthRoute.Forgot, MobileAuthRoute.EmailLogin -> validEmail
    }
    fun submit(target: MobileAuthRoute) {
        if (target != route || !canContinue(target) || state.isLoading) return
        focusManager.clearFocus()
        keyboardController?.hide()
        when (target) {
            MobileAuthRoute.Login -> viewModel.login(normalizedEmail, password)
            MobileAuthRoute.Register -> navigate(MobileAuthRoute.RegisterPassword)
            MobileAuthRoute.RegisterPassword -> sendCode("register", MobileAuthRoute.RegisterCode)
            MobileAuthRoute.RegisterCode -> viewModel.registerAccount(normalizedEmail, password, displayName, inviteToken, code)
            MobileAuthRoute.Forgot -> sendCode("reset_password", MobileAuthRoute.Reset)
            MobileAuthRoute.Reset -> navigate(MobileAuthRoute.ResetPassword)
            MobileAuthRoute.ResetPassword -> viewModel.resetPassword(normalizedEmail, code, password) {
                password = ""; confirmPassword = ""; code = ""; resendIn = 0
                navigatingBack = true
                route = MobileAuthRoute.Login
            }
            MobileAuthRoute.EmailLogin -> sendCode("login", MobileAuthRoute.EmailLoginCode)
            MobileAuthRoute.EmailLoginCode -> viewModel.loginWithEmailCode(normalizedEmail, code)
        }
    }
    fun title(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> "欢迎回来"
        MobileAuthRoute.Register -> "创建账号"
        MobileAuthRoute.RegisterPassword -> "设置密码"
        MobileAuthRoute.RegisterCode -> "验证邮箱"
        MobileAuthRoute.Forgot -> "找回密码"
        MobileAuthRoute.Reset -> "验证邮箱"
        MobileAuthRoute.ResetPassword -> "设置新密码"
        MobileAuthRoute.EmailLogin -> "邮箱登录"
        MobileAuthRoute.EmailLoginCode -> "查收邮件"
    }
    fun detail(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> "和伴星一起，继续你的学习。"
        MobileAuthRoute.Register -> "和伴星一起，开启你的学习。"
        MobileAuthRoute.RegisterPassword -> "为你的手记与对话，添一份安心。"
        MobileAuthRoute.RegisterCode -> "只差一步，就能和伴星相遇。"
        MobileAuthRoute.Forgot -> "验证邮箱，就能重新设置密码。"
        MobileAuthRoute.Reset -> "确认是你，再为账号设置新密码。"
        MobileAuthRoute.ResetPassword -> "换一个新密码，继续你的学习。"
        MobileAuthRoute.EmailLogin -> "一封验证码，继续你的学习。"
        MobileAuthRoute.EmailLoginCode -> "输入验证码，和伴星继续同行。"
    }
    fun progress(target: MobileAuthRoute): Pair<Int, Int>? = when (target) {
        MobileAuthRoute.Register -> 1 to 3
        MobileAuthRoute.RegisterPassword -> 2 to 3
        MobileAuthRoute.RegisterCode -> 3 to 3
        MobileAuthRoute.Forgot -> 1 to 3
        MobileAuthRoute.Reset -> 2 to 3
        MobileAuthRoute.ResetPassword -> 3 to 3
        MobileAuthRoute.EmailLogin -> 1 to 2
        MobileAuthRoute.EmailLoginCode -> 2 to 2
        MobileAuthRoute.Login -> null
    }
    fun flowName(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Register, MobileAuthRoute.RegisterPassword, MobileAuthRoute.RegisterCode -> "创建账号"
        MobileAuthRoute.Forgot, MobileAuthRoute.Reset, MobileAuthRoute.ResetPassword -> "找回密码"
        else -> "验证码登录"
    }
    fun actionTitle(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> if (state.isLoading) "正在登录" else "登录"
        MobileAuthRoute.Register -> "继续"
        MobileAuthRoute.RegisterPassword -> if (state.isLoading) "正在发送验证码" else "发送验证码"
        MobileAuthRoute.RegisterCode -> if (state.isLoading) "正在创建账号" else "验证并创建账号"
        MobileAuthRoute.Forgot -> if (state.isLoading) "正在发送验证码" else "发送验证码"
        MobileAuthRoute.Reset -> "继续设置密码"
        MobileAuthRoute.ResetPassword -> if (state.isLoading) "正在更新密码" else "更新密码"
        MobileAuthRoute.EmailLogin -> if (state.isLoading) "正在发送验证码" else "发送验证码"
        MobileAuthRoute.EmailLoginCode -> if (state.isLoading) "正在验证" else "验证并登录"
    }
    fun errorTitle(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login, MobileAuthRoute.EmailLoginCode -> "登录没有完成"
        MobileAuthRoute.Register, MobileAuthRoute.RegisterPassword, MobileAuthRoute.RegisterCode -> "账号还没有创建"
        MobileAuthRoute.Forgot, MobileAuthRoute.Reset, MobileAuthRoute.ResetPassword -> "密码还没有更新"
        MobileAuthRoute.EmailLogin -> "验证码没有发送"
    }

    BackHandler(route != MobileAuthRoute.Login && !state.isLoading) { goBack() }
    val haze = rememberHazeState()
    CompositionLocalProvider(LocalAstellaHaze provides haze) {
        BoxWithConstraints(
            Modifier.fillMaxSize().background(Color.White)
                .windowInsetsPadding(WindowInsets.safeDrawing).imePadding(),
        ) {
            Box(Modifier.matchParentSize().background(Color.White).hazeSource(haze))
            val compact = maxHeight < 600.dp || androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.3f
            Column(
                Modifier.align(Alignment.TopCenter).widthIn(max = 480.dp).fillMaxSize()
                    .padding(horizontal = 24.dp).padding(top = if (compact) 8.dp else 12.dp, bottom = 16.dp),
            ) {
                val brandOffset by animateDpAsState(
                    if (route == MobileAuthRoute.Login) 0.dp else 56.dp,
                    if (reduceMotion) snap() else MotionTokens.authRoute(), label = "auth-brand-position",
                )
                val brandScale by animateFloatAsState(
                    if (route == MobileAuthRoute.Login) 1f else .94f,
                    if (reduceMotion) snap() else MotionTokens.authRoute(), label = "auth-brand-scale",
                )
                Box(Modifier.fillMaxWidth().height(44.dp), contentAlignment = Alignment.CenterStart) {
                    AuthBrandHeader(compact, Modifier.graphicsLayer {
                        translationX = brandOffset.toPx()
                        scaleX = brandScale; scaleY = brandScale
                        transformOrigin = TransformOrigin(0f, .5f)
                    })
                    androidx.compose.animation.AnimatedVisibility(visible = route != MobileAuthRoute.Login,
                        enter = fadeIn(MotionTokens.authFade()), exit = fadeOut(MotionTokens.authFade())) {
                        AstellaTap({ goBack() }, Modifier.size(44.dp).astellaGlass(22.dp, interactive = true), enabled = !state.isLoading) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回上一步", Modifier.align(Alignment.Center).size(18.dp), tint = StudyPalette.ink)
                        }
                    }
                }
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                    val visibleFields = when (route) {
                        MobileAuthRoute.Login -> listOf(MobileAuthInput.Email, MobileAuthInput.Password)
                        MobileAuthRoute.Register -> listOf(MobileAuthInput.Email, MobileAuthInput.Name)
                        MobileAuthRoute.RegisterPassword, MobileAuthRoute.ResetPassword -> listOf(MobileAuthInput.Password, MobileAuthInput.Confirm)
                        MobileAuthRoute.Forgot, MobileAuthRoute.EmailLogin -> listOf(MobileAuthInput.Email)
                        else -> emptyList()
                    }
                    val headingGap by animateDpAsState(
                        if (compact) 18.dp else if (route == MobileAuthRoute.Login) 52.dp else 34.dp,
                        if (reduceMotion) snap() else MotionTokens.authRoute(), label = "auth-heading-position",
                    )
                    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight),
                        verticalArrangement = Arrangement.SpaceBetween) {
                        Column {
                            Spacer(Modifier.height(headingGap))
                            AuthHeading(title(route), detail(route), compact, navigatingBack, reduceMotion)
                            androidx.compose.animation.AnimatedVisibility(visible = progress(route) != null,
                                enter = fadeIn(MotionTokens.authFade()) + expandVertically(if (reduceMotion) snap() else MotionTokens.authRoute()),
                                exit = fadeOut(MotionTokens.authFade()) + shrinkVertically(if (reduceMotion) snap() else MotionTokens.authRoute())) {
                                Column {
                                    Spacer(Modifier.height(if (compact) 12.dp else 24.dp))
                                    val step = progress(route) ?: (1 to 3)
                                    AuthStepProgress(flowName(route), step.first, step.second)
                                }
                            }
                            Spacer(Modifier.height(if (compact) 16.dp else 24.dp))
                            Column(Modifier.fillMaxWidth().animateContentSize(if (reduceMotion) snap() else MotionTokens.authRoute()),
                                verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 14.dp)) {
                                Column {
                                    MobileAuthInput.entries.forEach { field ->
                                        key(field) {
                                            androidx.compose.animation.AnimatedVisibility(visible = field in visibleFields,
                                                enter = fadeIn(MotionTokens.authFade()) + expandVertically(if (reduceMotion) snap() else MotionTokens.authRoute(), expandFrom = Alignment.Top),
                                                exit = fadeOut(MotionTokens.authFade()) + shrinkVertically(if (reduceMotion) snap() else MotionTokens.authRoute(), shrinkTowards = Alignment.Top)) {
                                                Column {
                                                    when (field) {
                                                        MobileAuthInput.Email -> AuthInputField(email, { email = it; code = ""; resendIn = 0; clearFeedback() },
                                                            label = if (route == MobileAuthRoute.Forgot) "注册邮箱" else "邮箱",
                                                            placeholder = if (route == MobileAuthRoute.Forgot) "请输入注册时的邮箱" else "请输入邮箱地址",
                                                            keyboardType = KeyboardType.Email,
                                                            autofillType = ContentType.EmailAddress + if (route == MobileAuthRoute.Register) ContentType.NewUsername else ContentType.Username,
                                                            enabled = !state.isLoading,
                                                            imeAction = if (visibleFields.size > 1) ImeAction.Next else ImeAction.Done,
                                                            onImeAction = { if (visibleFields.size > 1) focusManager.moveFocus(FocusDirection.Next) else submit(route) })
                                                        MobileAuthInput.Password -> AuthInputField(password, { password = it; viewModel.clearAuthError() },
                                                            label = if (route == MobileAuthRoute.ResetPassword) "新密码" else "密码",
                                                            placeholder = if (route == MobileAuthRoute.Login) "请输入密码" else "至少 8 个字符",
                                                            keyboardType = KeyboardType.Password, password = true,
                                                            autofillType = if (route == MobileAuthRoute.Login) ContentType.Password else ContentType.NewPassword,
                                                            enabled = !state.isLoading,
                                                            imeAction = if (route == MobileAuthRoute.Login) ImeAction.Done else ImeAction.Next,
                                                            onImeAction = { if (route == MobileAuthRoute.Login) submit(route) else focusManager.moveFocus(FocusDirection.Next) })
                                                        MobileAuthInput.Name -> AuthInputField(displayName, { displayName = it }, label = "称呼（选填）",
                                                            placeholder = "希望伴星怎么称呼你", enabled = !state.isLoading, onImeAction = { submit(route) })
                                                        MobileAuthInput.Confirm -> AuthInputField(confirmPassword, { confirmPassword = it; viewModel.clearAuthError() },
                                                            label = if (route == MobileAuthRoute.ResetPassword) "确认新密码" else "确认密码",
                                                            placeholder = if (route == MobileAuthRoute.ResetPassword) "请再次输入新密码" else "请再次输入密码",
                                                            keyboardType = KeyboardType.Password, password = true, autofillType = ContentType.NewPassword,
                                                            enabled = !state.isLoading, onImeAction = { submit(route) })
                                                    }
                                                    if (field != visibleFields.lastOrNull()) Spacer(Modifier.height(if (compact) 10.dp else 15.dp))
                                                }
                                            }
                                        }
                                    }
                                }
                                if (MobileAuthInput.Email in visibleFields && !validEmail && email.isNotEmpty()) AuthFieldError("请输入有效的邮箱地址")
                                AnimatedContent(targetState = route,
                                    transitionSpec = { fadeIn(MotionTokens.authFade()) togetherWith fadeOut(MotionTokens.authFade()) },
                                    label = "auth-step-details") { page ->
                                    Column(verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 14.dp)) {
                                        when (page) {
                                            MobileAuthRoute.Login -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                                AstellaTextButton(onClick = { navigate(MobileAuthRoute.Forgot) }, enabled = !state.isLoading,
                                                    contentPadding = PaddingValues(horizontal = 0.dp)) { Text("忘记密码？", fontSize = 13.sp) }
                                            }
                                            MobileAuthRoute.Register -> {
                                                AstellaTextButton(onClick = { showInviteField = !showInviteField }, enabled = !state.isLoading,
                                                    contentPadding = PaddingValues(horizontal = 0.dp)) { Text(if (showInviteField) "收起邀请码" else "有邀请码？", fontSize = 13.sp) }
                                                androidx.compose.animation.AnimatedVisibility(visible = showInviteField,
                                                    enter = fadeIn(MotionTokens.authFade()) + expandVertically(if (reduceMotion) snap() else MotionTokens.authRoute()),
                                                    exit = fadeOut(MotionTokens.authFade()) + shrinkVertically(if (reduceMotion) snap() else MotionTokens.authRoute())) {
                                                    AuthInputField(inviteToken, { inviteToken = it }, label = "邀请码", placeholder = "选填", enabled = !state.isLoading)
                                                }
                                            }
                                            MobileAuthRoute.RegisterPassword, MobileAuthRoute.ResetPassword -> {
                                                if (!confirmMatches && confirmPassword.isNotEmpty()) AuthFieldError("两次输入的密码不一致")
                                                Text(if (page == MobileAuthRoute.RegisterPassword) "密码可随时重置，请放心记录。" else "更新后，请使用新密码登录。", color = StudyPalette.muted, fontSize = 12.sp)
                                            }
                                            MobileAuthRoute.RegisterCode, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode -> {
                                                AuthCodeRecipient(normalizedEmail, page == MobileAuthRoute.Reset, !state.isLoading) {
                                                    navigate(when (page) {
                                                        MobileAuthRoute.RegisterCode -> MobileAuthRoute.Register
                                                        MobileAuthRoute.Reset -> MobileAuthRoute.Forgot
                                                        else -> MobileAuthRoute.EmailLogin
                                                    })
                                                }
                                                AuthCodeField(code, { code = it; viewModel.clearAuthError() }, ImeAction.Done, !state.isLoading) { submit(page) }
                                                AstellaTextButton(onClick = { sendCode(when (page) {
                                                    MobileAuthRoute.RegisterCode -> "register"
                                                    MobileAuthRoute.Reset -> "reset_password"
                                                    else -> "login"
                                                }, page) }, modifier = Modifier.fillMaxWidth(), enabled = !state.isLoading && resendIn == 0) {
                                                    Text(if (resendIn > 0) "重新发送（${resendIn}秒）" else "重新发送验证码", fontSize = 13.sp)
                                                }
                                            }
                                            MobileAuthRoute.Forgot, MobileAuthRoute.EmailLogin -> Text(
                                                if (page == MobileAuthRoute.Forgot) "我们会向此邮箱发送重置验证码。" else "无需密码，验证码将发送到你的邮箱。",
                                                color = StudyPalette.muted, fontSize = 12.sp)
                                        }
                                    }
                                }
                                state.authError?.let { AuthFeedbackBanner(errorTitle(route), it, isError = true) }
                                if (state.authNotice != null && route !in setOf(MobileAuthRoute.RegisterCode, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode)) {
                                    AuthFeedbackBanner("已完成", state.authNotice, isError = false)
                                }
                                // One submit control follows the changing form height instead of entering with each page.
                                AuthPrimaryButton(actionTitle(route), state.isLoading, canContinue(route) && !state.isLoading) { submit(route) }
                                androidx.compose.animation.AnimatedVisibility(visible = route == MobileAuthRoute.Login,
                                    enter = fadeIn(MotionTokens.authFade()) + expandVertically(if (reduceMotion) snap() else MotionTokens.authRoute()),
                                    exit = fadeOut(MotionTokens.authFade()) + shrinkVertically(if (reduceMotion) snap() else MotionTokens.authRoute())) {
                                    AstellaTextButton(onClick = { navigate(MobileAuthRoute.EmailLogin) }, modifier = Modifier.fillMaxWidth(), enabled = !state.isLoading) {
                                        Text("邮箱验证码登录", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                                    }
                                }
                            }
                            Spacer(Modifier.height(if (compact) 8.dp else 16.dp))
                            AnimatedContent(targetState = route, transitionSpec = { fadeIn(MotionTokens.authFade()) togetherWith fadeOut(MotionTokens.authFade()) }, label = "auth-footer") { page ->
                                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                                    when (page) {
                                        MobileAuthRoute.Login, MobileAuthRoute.Register -> {
                                            Text(if (page == MobileAuthRoute.Login) "还没有账号？" else "已有账号？", color = StudyPalette.muted, fontSize = 13.sp)
                                            AstellaTextButton(onClick = { navigate(if (page == MobileAuthRoute.Login) MobileAuthRoute.Register else MobileAuthRoute.Login) }, enabled = !state.isLoading,
                                                contentPadding = PaddingValues(horizontal = 5.dp)) {
                                                Text(if (page == MobileAuthRoute.Login) "创建账号" else "返回登录", fontSize = 13.sp, fontWeight = FontWeight.Medium)
                                            }
                                        }
                                        MobileAuthRoute.RegisterCode -> Text("完成验证后，将自动登录。", color = StudyPalette.muted, fontSize = 13.sp)
                                        else -> AstellaTextButton(onClick = {
                                            when (route) {
                                                MobileAuthRoute.RegisterPassword, MobileAuthRoute.Reset -> goBack()
                                                else -> navigate(MobileAuthRoute.Login)
                                            }
                                        }, enabled = !state.isLoading) {
                                            Text(when (page) {
                                                MobileAuthRoute.RegisterPassword, MobileAuthRoute.Reset -> "返回上一步"
                                                MobileAuthRoute.EmailLogin, MobileAuthRoute.EmailLoginCode -> "使用密码登录"
                                                else -> "返回登录"
                                            }, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                                        }
                                    }
                                }
                            }
                        }
                        if (!compact) Text("你的手记与对话，会在各端同步", color = StudyPalette.muted, fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().padding(top = 44.dp), textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}

private enum class MobileAuthInput { Email, Password, Name, Confirm }

private enum class MobileAuthRoute {
    Login, Register, RegisterPassword, RegisterCode, Forgot, Reset, ResetPassword, EmailLogin, EmailLoginCode,
}

private val MobileAuthRoute.depth: Int
    get() = when (this) {
        MobileAuthRoute.Login -> 0
        MobileAuthRoute.Register, MobileAuthRoute.Forgot, MobileAuthRoute.EmailLogin -> 1
        MobileAuthRoute.RegisterPassword, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode -> 2
        MobileAuthRoute.RegisterCode, MobileAuthRoute.ResetPassword -> 3
    }

@Composable
private fun AuthStepProgress(title: String, current: Int, total: Int) {
    Text("$title · $current / $total", color = StudyPalette.muted, fontSize = 13.sp, fontWeight = FontWeight.Medium)
}

@Composable
private fun AuthFieldGroup(
    compact: Boolean = false,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 15.dp), content = content)
}

@Composable
private fun AuthFieldError(message: String) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Icon(Icons.Filled.WarningAmber, contentDescription = null,
            modifier = Modifier.padding(top = 1.dp).size(15.dp), tint = StudyPalette.danger)
        Text(message, color = StudyPalette.danger,
            style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 19.sp)
    }
}

@Composable
private fun AuthFeedbackBanner(title: String, message: String, isError: Boolean) {
    val tint = if (isError) StudyPalette.danger else StudyPalette.accent
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(StudyRadius.md),
        color = tint.copy(alpha = .08f),
        border = androidx.compose.foundation.BorderStroke(.8.dp, tint.copy(alpha = .16f)),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.Top) {
            androidx.compose.foundation.layout.Box(
                Modifier.padding(top = 1.dp).size(20.dp).clip(CircleShape).background(tint.copy(alpha = .12f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(if (isError) "!" else "✓", color = tint, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            }
            Column(Modifier.padding(start = 9.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, color = StudyPalette.ink, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text(message, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun AuthCodeRecipient(email: String, reset: Boolean, enabled: Boolean, onChange: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (reset) "重置验证码已发送至" else "验证码已发送至", color = StudyPalette.muted, fontSize = 14.sp)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(email, Modifier.weight(1f), color = StudyPalette.ink, fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            AstellaTextButton(onClick = onChange, enabled = enabled, contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 8.dp)) {
                Text("更改邮箱", fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun AuthCodeField(code: String, onCodeChange: (String) -> Unit, imeAction: ImeAction, enabled: Boolean, onDone: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    val focused by interactionSource.collectIsFocusedAsState()
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text("邮箱验证码", color = StudyPalette.ink.copy(alpha = .82f),
            style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        androidx.compose.foundation.layout.Box(
            Modifier.fillMaxWidth().height(62.dp),
            contentAlignment = Alignment.Center,
        ) {
            BasicTextField(
                value = code,
                onValueChange = { onCodeChange(it.filter(Char::isDigit).take(6)) },
                modifier = Modifier.fillMaxSize().semantics { contentDescription = "6 位邮箱验证码" },
                singleLine = true,
                enabled = enabled,
                textStyle = TextStyle(color = Color.Transparent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number, imeAction = imeAction),
                keyboardActions = KeyboardActions(onDone = { onDone() }),
                cursorBrush = SolidColor(Color.Transparent),
                interactionSource = interactionSource,
                decorationBox = { innerTextField ->
                    androidx.compose.foundation.layout.Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            repeat(6) { index ->
                                val active = focused && index == code.length.coerceAtMost(5)
                                Box(
                                    Modifier.weight(1f).height(58.dp).astellaGlass(16.dp)
                                        .border(if (active) 1.dp else 0.dp, if (active) StudyPalette.accent.copy(alpha = .5f) else Color.Transparent, RoundedCornerShape(16.dp)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (index < code.length) {
                                        Text(code[index].toString(), color = StudyPalette.ink, fontSize = 21.sp, fontWeight = FontWeight.SemiBold)
                                    } else if (active) {
                                        Box(Modifier.width(19.dp).height(2.dp).background(StudyPalette.accent, CircleShape))
                                    }
                                }
                            }
                        }
                        innerTextField()
                    }
                },
            )
        }
    }
}

@Composable
private fun AuthInputField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    placeholder: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    password: Boolean = false,
    enabled: Boolean = true,
    autofillType: ContentType? = null,
    imeAction: ImeAction = ImeAction.Done,
    onImeAction: (() -> Unit)? = null,
) {
    var revealed by rememberSaveable { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(26.dp)
    val icon = when {
        password -> Icons.Outlined.Lock
        keyboardType == KeyboardType.Email -> Icons.Outlined.Email
        label.contains("邀请码") -> Icons.Filled.Key
        else -> Icons.Outlined.Person
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(label, color = StudyPalette.ink.copy(alpha = .82f), fontSize = 14.sp, fontWeight = FontWeight.Medium)
        BasicTextField(
            value = value, onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).astellaGlass(26.dp, interactive = true)
                .border(if (focused) 1.dp else 0.dp, if (focused) StudyPalette.accent.copy(alpha = .5f) else Color.Transparent, shape)
                .semantics { contentDescription = label; if (autofillType != null) contentType = autofillType },
            enabled = enabled, singleLine = true, interactionSource = interaction,
            textStyle = TextStyle(color = StudyPalette.ink, fontSize = 16.sp),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
            keyboardActions = KeyboardActions(onNext = { onImeAction?.invoke() }, onDone = { onImeAction?.invoke() }),
            cursorBrush = SolidColor(StudyPalette.accent),
            visualTransformation = if (password && !revealed) androidx.compose.ui.text.input.PasswordVisualTransformation()
                else androidx.compose.ui.text.input.VisualTransformation.None,
            decorationBox = { inner ->
                Row(Modifier.heightIn(min = 56.dp).padding(start = 19.dp, end = if (password) 8.dp else 19.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(icon, null, Modifier.size(20.dp), tint = StudyPalette.muted)
                    Box(Modifier.weight(1f).padding(vertical = 14.dp)) {
                        if (value.isEmpty()) Text(placeholder, color = StudyPalette.muted, fontSize = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        inner()
                    }
                    if (password) AstellaIconButton(onClick = { revealed = !revealed }, enabled = enabled) {
                        Icon(if (revealed) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                            if (revealed) "隐藏密码" else "显示密码", Modifier.size(19.dp), tint = StudyPalette.muted)
                    }
                }
            },
        )
    }
}

@Composable
private fun AuthBrandHeader(compact: Boolean, modifier: Modifier = Modifier) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
        Image(painterResource(R.drawable.brand_mark), null, Modifier.size(if (compact) 36.dp else 44.dp), contentScale = ContentScale.Fit)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text("拾星笔记", color = StudyPalette.ink, fontSize = if (compact) 16.sp else 18.sp, fontWeight = FontWeight.SemiBold)
            Text("ASTELLA", color = StudyPalette.muted, fontSize = 9.sp, letterSpacing = 2.5.sp, fontWeight = FontWeight.Medium)
        }
    }
}

@Composable
private fun AuthHeading(title: String, detail: String, compact: Boolean, backward: Boolean, reduceMotion: Boolean) {
    val enterDistance = with(androidx.compose.ui.platform.LocalDensity.current) { 22.dp.roundToPx() }
    val exitDistance = with(androidx.compose.ui.platform.LocalDensity.current) { 14.dp.roundToPx() }
    Column(verticalArrangement = Arrangement.spacedBy(if (compact) 4.dp else 10.dp)) {
        AnimatedContent(targetState = title, transitionSpec = {
            if (reduceMotion) fadeIn(MotionTokens.authFade()) togetherWith fadeOut(MotionTokens.authFade())
            else {
                val direction = if (backward) -1 else 1
                (fadeIn(MotionTokens.authFade()) + slideInHorizontally(MotionTokens.authRoute()) { enterDistance * direction }) togetherWith
                    (fadeOut(MotionTokens.authFade()) + slideOutHorizontally(MotionTokens.authRoute()) { -exitDistance * direction })
            }
        }, label = "auth-heading") { value ->
            Text(value, color = StudyPalette.ink, fontSize = if (compact) 23.sp else 34.sp,
                lineHeight = if (compact) 30.sp else 42.sp, letterSpacing = (-.8).sp, fontWeight = FontWeight.SemiBold)
        }
        if (!compact) AnimatedContent(targetState = detail,
            transitionSpec = { fadeIn(MotionTokens.authFade()) togetherWith fadeOut(MotionTokens.authFade()) }, label = "auth-subtitle") {
            Text(it, color = StudyPalette.muted, fontSize = 14.sp, lineHeight = 21.sp)
        }
    }
}

@Composable
private fun AuthPrimaryButton(title: String, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val active = enabled || busy
    AstellaTap(onClick, Modifier.fillMaxWidth().heightIn(min = 56.dp)
        .astellaGlass(28.dp, interactive = true, tint = if (active) StudyPalette.actionFill.copy(alpha = .82f) else Color.Transparent)
        .graphicsLayer { alpha = if (active) 1f else .6f }, enabled) {
        Row(Modifier.align(Alignment.Center).padding(horizontal = 22.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (busy) CircularProgressIndicator(Modifier.size(17.dp), color = StudyPalette.ink, strokeWidth = 2.dp)
            Text(title, color = if (active) StudyPalette.ink else StudyPalette.muted, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
        }
    }
}
