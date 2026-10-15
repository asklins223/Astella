package com.astella.mobile.ui.screens

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.Image
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.tween
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.Book
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MarkEmailRead
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Surface
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.autofill.ContentType
import com.astella.mobile.R
import com.astella.mobile.data.AppUiState
import com.astella.mobile.data.AppViewModel
import com.astella.mobile.data.AIDataPolicy
import com.astella.mobile.data.NoteBlock
import com.astella.mobile.data.NoteDocument
import com.astella.mobile.data.NoteAnnotation
import com.astella.mobile.data.NoteAnnotationAnchor
import com.astella.mobile.data.NoteSummary
import com.astella.mobile.ui.ConnectionFailureNotice
import com.astella.mobile.ui.CompanionPortrait
import com.astella.mobile.ui.NoticeSurface
import com.astella.mobile.ui.PaperSurface
import com.astella.mobile.ui.PageHeading
import com.astella.mobile.ui.StudyPalette
import kotlinx.coroutines.delay

@Composable
fun LoginScreen(state: AppUiState, viewModel: AppViewModel) {
    val reduceMotion = state.localReduceMotion || com.astella.mobile.ui.rememberSystemReducedMotion()
    var route by rememberSaveable { mutableStateOf(MobileAuthRoute.Login) }
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
        if (state.isLoading) return
        keyboardController?.hide()
        if (!preserveNotice) clearFeedback()
        route = target
    }
    fun goBack() {
        code = ""
        resendIn = 0
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
        keyboardController?.hide()
        viewModel.sendEmailCode(normalizedEmail, purpose) { seconds ->
            keyboardController?.hide()
            code = ""
            resendIn = seconds
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
        if (!canContinue(target) || state.isLoading) return
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
                route = MobileAuthRoute.Login
            }
            MobileAuthRoute.EmailLogin -> sendCode("login", MobileAuthRoute.EmailLoginCode)
            MobileAuthRoute.EmailLoginCode -> viewModel.loginWithEmailCode(normalizedEmail, code)
        }
    }
    fun title(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> "继续你的学习"
        MobileAuthRoute.Register -> "创建你的书房"
        MobileAuthRoute.RegisterPassword -> "设置登录密码"
        MobileAuthRoute.RegisterCode -> "确认你的邮箱"
        MobileAuthRoute.Forgot -> "重置登录密码"
        MobileAuthRoute.Reset -> "验证你的邮箱"
        MobileAuthRoute.ResetPassword -> "设置新密码"
        MobileAuthRoute.EmailLogin -> "通过邮箱登录"
        MobileAuthRoute.EmailLoginCode -> "输入登录验证码"
    }
    fun detail(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> "登录后，你的手记、对话和进度都会同步。"
        MobileAuthRoute.Register -> "填写邮箱和称呼，下一步为书房设置密码。"
        MobileAuthRoute.RegisterPassword -> "密码至少 8 位。设置完成后，我们会发送验证邮件。"
        MobileAuthRoute.RegisterCode -> "输入发到邮箱的 6 位验证码，完成注册。"
        MobileAuthRoute.Forgot -> "填写注册邮箱，我们会发送密码重置验证码。"
        MobileAuthRoute.Reset -> "输入邮件中的 6 位验证码，确认这是你的邮箱。"
        MobileAuthRoute.ResetPassword -> "设置至少 8 位新密码，完成后即可重新登录。"
        MobileAuthRoute.EmailLogin -> "我们会发送一次性验证码，不需要密码。"
        MobileAuthRoute.EmailLoginCode -> "输入邮件中的 6 位验证码，安全登录书房。"
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
    fun pageIcon(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> Icons.Filled.Book
        MobileAuthRoute.Register -> Icons.Filled.PersonAdd
        MobileAuthRoute.RegisterPassword, MobileAuthRoute.ResetPassword -> Icons.Filled.Lock
        MobileAuthRoute.RegisterCode, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode -> Icons.Filled.MarkEmailRead
        MobileAuthRoute.Forgot -> Icons.Filled.Key
        MobileAuthRoute.EmailLogin -> Icons.Filled.Email
    }
    fun actionTitle(target: MobileAuthRoute) = when (target) {
        MobileAuthRoute.Login -> if (state.isLoading) "正在登录" else "登录"
        MobileAuthRoute.Register -> "继续"
        MobileAuthRoute.RegisterPassword -> if (state.isLoading) "正在发送验证码" else "发送验证邮件"
        MobileAuthRoute.RegisterCode -> if (state.isLoading) "正在创建账号" else "验证并创建账号"
        MobileAuthRoute.Forgot -> if (state.isLoading) "正在发送验证码" else "发送重置验证码"
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

    BoxWithConstraints(
        Modifier.fillMaxSize()
            .background(StudyPalette.canvas)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .imePadding(),
    ) {
        val compact = maxHeight < 660.dp || androidx.compose.ui.platform.LocalDensity.current.fontScale >= 1.15f ||
            (state.authError != null && maxHeight < 720.dp)
        Column(
            Modifier.fillMaxSize().padding(horizontal = 27.dp)
                .padding(top = if (compact) 8.dp else 20.dp, bottom = if (compact) 8.dp else 20.dp),
            verticalArrangement = Arrangement.Top,
        ) {
            if (route == MobileAuthRoute.Login) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Image(painter = painterResource(R.drawable.brand_mark), contentDescription = null,
                        modifier = Modifier.size(if (compact) 38.dp else 46.dp), contentScale = ContentScale.Fit)
                    Column(Modifier.padding(start = 11.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("拾星笔记", color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold, letterSpacing = (-0.35).sp)
                        Text("ASTELLA", color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                            fontSize = 9.sp, fontWeight = FontWeight.Medium, letterSpacing = 2.sp)
                    }
                }
                Spacer(Modifier.height(if (compact) 17.dp else 34.dp))
                Column(verticalArrangement = Arrangement.spacedBy(if (compact) 3.dp else 5.dp)) {
                    Text(title(route), color = StudyPalette.ink,
                        fontSize = if (compact) 27.sp else 31.sp, lineHeight = if (compact) 33.sp else 37.sp,
                        fontWeight = FontWeight.SemiBold, letterSpacing = (-0.8).sp)
                    if (!compact) Text(detail(route), color = StudyPalette.muted, fontSize = 15.sp, lineHeight = 21.sp)
                }
            } else {
                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { goBack() }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp)) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, modifier = Modifier.size(17.dp))
                        Text("返回", Modifier.padding(start = 4.dp))
                    }
                    Spacer(Modifier.weight(1f))
                    progress(route)?.let { (current, total) -> AuthStepProgress(current, total) }
                }
                Spacer(Modifier.height(if (compact) 7.dp else 17.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(
                        modifier = Modifier.size(if (compact) 44.dp else 54.dp),
                        shape = CircleShape,
                        color = StudyPalette.sky,
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Icon(pageIcon(route), contentDescription = null,
                                modifier = Modifier.size(if (compact) 19.dp else 23.dp), tint = StudyPalette.blueDeep)
                        }
                    }
                    Column(Modifier.padding(start = 13.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(title(route), color = StudyPalette.ink,
                            fontSize = if (compact) 25.sp else 29.sp, lineHeight = if (compact) 31.sp else 35.sp,
                            fontWeight = FontWeight.SemiBold, letterSpacing = (-0.65).sp)
                        if (!compact) Text(detail(route), color = StudyPalette.muted, fontSize = 14.sp, lineHeight = 20.sp)
                    }
                }
            }

            Spacer(Modifier.height(if (route == MobileAuthRoute.Login) { if (compact) 15.dp else 27.dp } else { if (compact) 12.dp else 20.dp }))
            AnimatedContent(
                targetState = route,
                transitionSpec = {
                    if (reduceMotion) fadeIn(tween(1)) togetherWith fadeOut(tween(1))
                    else fadeIn(tween(160)) togetherWith fadeOut(tween(100))
                },
                label = "account-flow",
            ) { activeRoute ->
                Column(verticalArrangement = Arrangement.spacedBy(if (compact) 10.dp else 13.dp)) {
                    when (activeRoute) {
                        MobileAuthRoute.Login -> {
                            AuthFieldGroup(compact = compact) {
                                AuthInputField(email, { email = it; code = ""; resendIn = 0; clearFeedback() },
                                    label = "邮箱", placeholder = "name@example.com", keyboardType = KeyboardType.Email,
                                    autofillType = ContentType.EmailAddress + ContentType.Username,
                                    enabled = !state.isLoading,
                                    imeAction = ImeAction.Next, onImeAction = { focusManager.moveFocus(FocusDirection.Next) })
                                AuthInputField(password, { password = it; viewModel.clearAuthError() },
                                    label = "密码", placeholder = "输入密码", keyboardType = KeyboardType.Password, password = true,
                                    autofillType = ContentType.Password,
                                    enabled = !state.isLoading,
                                    onImeAction = { submit(MobileAuthRoute.Login) })
                            }
                            if (!validEmail && email.isNotEmpty()) AuthFieldError("请输入有效的邮箱地址")
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                                TextButton(onClick = { navigate(MobileAuthRoute.Forgot) }, enabled = !state.isLoading,
                                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp)) { Text("忘记密码？") }
                            }
                        }
                        MobileAuthRoute.Register -> {
                            AuthFieldGroup(compact = compact) {
                                AuthInputField(email, { email = it; code = ""; resendIn = 0; clearFeedback() },
                                    label = "邮箱", placeholder = "name@example.com", keyboardType = KeyboardType.Email,
                                    autofillType = ContentType.EmailAddress + ContentType.NewUsername,
                                    enabled = !state.isLoading,
                                    imeAction = ImeAction.Next, onImeAction = { focusManager.moveFocus(FocusDirection.Next) })
                                AuthInputField(displayName, { displayName = it }, label = "称呼", placeholder = "选填",
                                    enabled = !state.isLoading,
                                    onImeAction = { submit(MobileAuthRoute.Register) })
                            }
                            if (!validEmail && email.isNotEmpty()) AuthFieldError("请输入有效的邮箱地址")
                            TextButton(onClick = { showInviteField = !showInviteField }, enabled = !state.isLoading,
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp)) {
                                Text(if (showInviteField) "收起邀请码" else "有邀请码？")
                            }
                            if (showInviteField) AuthInputField(inviteToken, { inviteToken = it }, label = "邀请码", placeholder = "选填", enabled = !state.isLoading)
                        }
                        MobileAuthRoute.RegisterPassword -> {
                            AuthFieldGroup(compact = compact) {
                                AuthInputField(password, { password = it; viewModel.clearAuthError() }, label = "密码",
                                    placeholder = "至少 8 个字符", keyboardType = KeyboardType.Password, password = true,
                                    autofillType = ContentType.NewPassword,
                                    enabled = !state.isLoading,
                                    imeAction = ImeAction.Next, onImeAction = { focusManager.moveFocus(FocusDirection.Next) })
                                AuthInputField(confirmPassword, { confirmPassword = it; viewModel.clearAuthError() }, label = "确认密码",
                                    placeholder = "再输入一次", keyboardType = KeyboardType.Password, password = true,
                                    autofillType = ContentType.NewPassword,
                                    enabled = !state.isLoading,
                                    onImeAction = { submit(MobileAuthRoute.RegisterPassword) })
                            }
                            if (!confirmMatches && confirmPassword.isNotEmpty()) AuthFieldError("两次输入的密码不一致")
                            Text("密码只用于保护你的书房，可随时重置。", color = StudyPalette.muted,
                                style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                        }
                        MobileAuthRoute.RegisterCode, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode -> {
                            AuthCodeRecipient(
                                email = normalizedEmail,
                                enabled = !state.isLoading,
                                onChange = {
                                    when (activeRoute) {
                                        MobileAuthRoute.RegisterCode -> navigate(MobileAuthRoute.Register)
                                        MobileAuthRoute.Reset -> navigate(MobileAuthRoute.Forgot)
                                        MobileAuthRoute.EmailLoginCode -> navigate(MobileAuthRoute.EmailLogin)
                                    }
                                },
                            )
                            AuthCodeField(
                                code = code,
                                onCodeChange = { code = it; viewModel.clearAuthError() },
                                imeAction = ImeAction.Done,
                                enabled = !state.isLoading,
                                onDone = { submit(activeRoute) },
                            )
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Text("没有收到邮件？", color = StudyPalette.muted,
                                    style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                                Spacer(Modifier.weight(1f))
                                TextButton(
                                    onClick = {
                                        val purpose = when (activeRoute) {
                                            MobileAuthRoute.RegisterCode -> "register"
                                            MobileAuthRoute.Reset -> "reset_password"
                                            else -> "login"
                                        }
                                        sendCode(purpose, activeRoute)
                                    },
                                    enabled = !state.isLoading && resendIn == 0,
                                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp),
                                ) { Text(if (resendIn > 0) "${resendIn}s 后重发" else "重新发送") }
                            }
                        }
                        MobileAuthRoute.ResetPassword -> {
                            AuthFieldGroup(compact = compact) {
                                AuthInputField(password, { password = it; viewModel.clearAuthError() }, label = "新密码",
                                    placeholder = "至少 8 个字符", keyboardType = KeyboardType.Password, password = true,
                                    autofillType = ContentType.NewPassword,
                                    enabled = !state.isLoading,
                                    imeAction = ImeAction.Next, onImeAction = { focusManager.moveFocus(FocusDirection.Next) })
                                AuthInputField(confirmPassword, { confirmPassword = it; viewModel.clearAuthError() }, label = "确认新密码",
                                    placeholder = "再输入一次", keyboardType = KeyboardType.Password, password = true,
                                    autofillType = ContentType.NewPassword,
                                    enabled = !state.isLoading,
                                    onImeAction = { submit(MobileAuthRoute.ResetPassword) })
                            }
                            if (!confirmMatches && confirmPassword.isNotEmpty()) AuthFieldError("两次输入的密码不一致")
                        }
                        MobileAuthRoute.Forgot, MobileAuthRoute.EmailLogin -> {
                            AuthInputField(email, { email = it; code = ""; resendIn = 0; clearFeedback() },
                                label = "邮箱", placeholder = "name@example.com", keyboardType = KeyboardType.Email,
                                autofillType = ContentType.EmailAddress + ContentType.Username,
                                enabled = !state.isLoading,
                                imeAction = ImeAction.Done, onImeAction = { submit(activeRoute) })
                            if (!validEmail && email.isNotEmpty()) AuthFieldError("请输入有效的邮箱地址")
                        }
                    }
                    state.authError?.let { AuthFeedbackBanner(errorTitle(activeRoute), it, isError = true) }
                    if (state.authNotice != null && activeRoute !in setOf(MobileAuthRoute.RegisterCode, MobileAuthRoute.Reset, MobileAuthRoute.EmailLoginCode)) {
                        AuthFeedbackBanner("已完成", state.authNotice, isError = false)
                    }
                    androidx.compose.material3.Button(
                        onClick = { submit(activeRoute) },
                        modifier = Modifier.fillMaxWidth().height(54.dp),
                        enabled = canContinue(activeRoute) && !state.isLoading,
                        shape = RoundedCornerShape(27.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = StudyPalette.blueDeep,
                            contentColor = Color.White,
                            disabledContainerColor = StudyPalette.paperEdge.copy(alpha = .82f),
                            disabledContentColor = StudyPalette.muted,
                        ),
                    ) {
                        if (state.isLoading) CircularProgressIndicator(Modifier.size(17.dp), color = Color.White, strokeWidth = 2.dp)
                        Text(actionTitle(activeRoute), Modifier.padding(start = 7.dp))
                    }
                    if (activeRoute == MobileAuthRoute.Login && !compact) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.foundation.layout.Box(Modifier.weight(1f).height(1.dp).background(StudyPalette.paperEdge))
                            Text("或", Modifier.padding(horizontal = 12.dp), color = StudyPalette.muted, fontSize = 12.sp)
                            androidx.compose.foundation.layout.Box(Modifier.weight(1f).height(1.dp).background(StudyPalette.paperEdge))
                        }
                        TextButton(
                            onClick = { navigate(MobileAuthRoute.EmailLogin) },
                            modifier = Modifier.fillMaxWidth().height(48.dp),
                            enabled = !state.isLoading,
                        ) { Text("邮箱验证码登录", fontWeight = FontWeight.Medium) }
                    }
                }
            }
            if (!compact) {
                when (route) {
                    MobileAuthRoute.Login -> {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                            Text("第一次使用？", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium)
                            TextButton(onClick = { navigate(MobileAuthRoute.Register) }, enabled = !state.isLoading) { Text("创建账号") }
                        }
                        Text("学习记录会在拾星各端同步", color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.labelSmall,
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp), textAlign = TextAlign.Center)
                    }
                    MobileAuthRoute.Register -> TextButton(onClick = { navigate(MobileAuthRoute.Login) },
                        modifier = Modifier.fillMaxWidth(), enabled = !state.isLoading) { Text("已经有书房？返回登录") }
                    MobileAuthRoute.Forgot -> TextButton(onClick = { navigate(MobileAuthRoute.Login) },
                        modifier = Modifier.fillMaxWidth(), enabled = !state.isLoading) { Text("想起密码了？返回登录") }
                    else -> Unit
                }
            }
        }
    }
}

private enum class MobileAuthRoute {
    Login, Register, RegisterPassword, RegisterCode, Forgot, Reset, ResetPassword, EmailLogin, EmailLoginCode,
}

@Composable
private fun AuthStepProgress(current: Int, total: Int) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            repeat(total) { index ->
                androidx.compose.foundation.layout.Box(
                    Modifier.width(17.dp).height(4.dp)
                        .clip(CircleShape)
                        .background(if (index < current) StudyPalette.blueDeep else StudyPalette.paperEdge),
                )
            }
        }
        Text("$current / $total", color = StudyPalette.muted,
            style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
    }
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
    val tint = if (isError) StudyPalette.danger else StudyPalette.blueDeep
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(13.dp),
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
private fun AuthCodeRecipient(email: String, enabled: Boolean, onChange: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(13.dp),
        color = StudyPalette.sky.copy(alpha = .65f),
    ) {
        Row(Modifier.padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Email, null, Modifier.size(15.dp), tint = StudyPalette.blueDeep)
            Text(email, Modifier.padding(start = 9.dp).weight(1f), color = StudyPalette.ink,
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            TextButton(onClick = onChange, enabled = enabled) { Text("更改") }
        }
    }
}

@Composable
private fun AuthCodeField(code: String, onCodeChange: (String) -> Unit, imeAction: ImeAction, enabled: Boolean, onDone: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    val focused by interactionSource.collectIsFocusedAsState()
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text("验证码", color = StudyPalette.ink.copy(alpha = .82f),
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
                        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                            repeat(6) { index ->
                                val active = focused && index == code.length.coerceAtMost(5)
                                Surface(
                                    modifier = Modifier.weight(1f).height(58.dp),
                                    shape = RoundedCornerShape(12.dp),
                                    color = StudyPalette.paper.copy(alpha = if (active) .96f else .78f),
                                    border = androidx.compose.foundation.BorderStroke(
                                        if (active) 1.4.dp else .8.dp,
                                        if (active) StudyPalette.blueDeep else StudyPalette.paperEdge.copy(alpha = .8f),
                                    ),
                                ) {
                                    androidx.compose.foundation.layout.Box(contentAlignment = Alignment.Center) {
                                        if (index < code.length) {
                                            Text(code[index].toString(), color = StudyPalette.ink, fontSize = 21.sp,
                                                fontWeight = FontWeight.SemiBold)
                                        } else if (active) {
                                            androidx.compose.foundation.layout.Box(Modifier.width(2.dp).height(20.dp).background(StudyPalette.blueDeep))
                                        }
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
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(label, color = StudyPalette.ink.copy(alpha = .82f),
            style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium)
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics {
                contentDescription = label
                if (autofillType != null) contentType = autofillType
            },
            enabled = enabled,
            singleLine = true,
            placeholder = { Text(placeholder, color = StudyPalette.muted.copy(alpha = .72f)) },
            textStyle = TextStyle(color = StudyPalette.ink, fontSize = 16.sp),
            keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = imeAction),
            keyboardActions = KeyboardActions(
                onNext = { onImeAction?.invoke() },
                onDone = { onImeAction?.invoke() },
            ),
            visualTransformation = if (password && !revealed) androidx.compose.ui.text.input.PasswordVisualTransformation()
                else androidx.compose.ui.text.input.VisualTransformation.None,
            trailingIcon = if (password) {
                {
                    IconButton(onClick = { revealed = !revealed }, modifier = Modifier.size(44.dp)) {
                        Icon(
                            if (revealed) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                            contentDescription = if (revealed) "隐藏密码" else "显示密码",
                            tint = StudyPalette.muted,
                            modifier = Modifier.size(19.dp),
                        )
                    }
                }
            } else null,
            shape = RoundedCornerShape(16.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedTextColor = StudyPalette.ink,
                unfocusedTextColor = StudyPalette.ink,
                focusedContainerColor = StudyPalette.paper.copy(alpha = .96f),
                unfocusedContainerColor = StudyPalette.paper.copy(alpha = .9f),
                focusedBorderColor = StudyPalette.blueDeep,
                unfocusedBorderColor = StudyPalette.paperEdge.copy(alpha = .85f),
                focusedPlaceholderColor = StudyPalette.muted,
                unfocusedPlaceholderColor = StudyPalette.muted,
                cursorColor = StudyPalette.blueDeep,
            ),
        )
    }
}

@Composable
fun HandScreen(state: AppUiState, viewModel: AppViewModel, onAccount: () -> Unit, onConversation: () -> Unit) {
    if (state.runs.isEmpty()) {
        Column(Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PageHeading(state.profile?.workspaceName ?: "我的书房", "手边", "需要你接续的学习工作，会在这里等你。", modifier = Modifier.weight(1f))
                IconButton(onClick = onAccount) { Icon(Icons.Filled.AccountCircle, "我的账户", tint = StudyPalette.blueDeep) }
            }
            state.error?.let { error ->
                ConnectionFailureNotice("连接暂时中断", error, "重新连接") { viewModel.loadConversation() }
            }
            if (state.error == null) {
                Row(Modifier.padding(top = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(7.dp).clip(CircleShape).background(if (state.realtimeStatus == "已连接") StudyPalette.success else StudyPalette.muted))
                    Text("${state.realtimeStatus} · 与当前书房同步", Modifier.padding(start = 7.dp), color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Icon(Icons.Filled.CheckCircle, contentDescription = null,
                        modifier = Modifier.padding(bottom = 4.dp).size(28.dp), tint = StudyPalette.blueDeep)
                    Text("暂时没有待确认事项", color = StudyPalette.ink,
                        style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text("新的学习步骤会在需要你时出现在这里。",
                        Modifier.padding(horizontal = 16.dp), color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                        lineHeight = 21.sp, textAlign = TextAlign.Center)
                    androidx.compose.material3.TextButton(
                        onClick = onConversation,
                        modifier = Modifier.padding(top = 1.dp).heightIn(min = 44.dp),
                    ) { Text("回到对话") }
                }
            }
        }
        return
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 22.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PageHeading(state.profile?.workspaceName ?: "我的书房", "手边", "需要你接续的学习工作，会在这里等你。", modifier = Modifier.weight(1f))
                IconButton(onClick = onAccount) { Icon(Icons.Filled.AccountCircle, "我的账户", tint = StudyPalette.blueDeep) }
            }
        }
        state.error?.let { error -> item {
            Spacer(Modifier.height(16.dp))
            ConnectionFailureNotice("连接暂时中断", error, "重新连接") { viewModel.loadConversation() }
        } }
            item {
                Row(Modifier.fillMaxWidth().padding(top = 23.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("正在进行", color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.weight(1f))
                    Text("${state.runs.size} 项", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                }
            }
            items(state.runs, key = { it.id }) { run ->
                Row(Modifier.fillMaxWidth().padding(vertical = 14.dp), verticalAlignment = Alignment.Top) {
                    Column(Modifier.width(18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.padding(top = 5.dp).size(9.dp).clip(CircleShape)
                            .background(if (run.status == "waiting_for_confirmation") StudyPalette.blueDeep else StudyPalette.blue.copy(alpha = .5f)))
                        if (run != state.runs.last()) Box(Modifier.padding(top = 5.dp).width(1.dp).height(75.dp).background(StudyPalette.paperEdge))
                    }
                    Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(run.statusLabel, color = StudyPalette.blueDeep, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.weight(1f))
                            if (run.status != "waiting_for_confirmation") CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = StudyPalette.blue)
                        }
                        Text(run.thinkingText ?: when (run.status) {
                            "accepted" -> "这一轮已经接收，马上开始处理。"
                            "waiting_for_confirmation" -> "伴星正在等你确认下一步。请回到对话查看具体内容。"
                            "cancel_requested" -> "正在结束这一轮，稍后会同步最终状态。"
                            else -> "这一轮还在路上。你可以切去读手记，工作会继续。"
                        }, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("已进行 ${run.stepCount} 步", Modifier.weight(1f), color = StudyPalette.muted,
                                style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                            androidx.compose.material3.TextButton(onClick = onConversation, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp, vertical = 0.dp)) {
                                Text("查看对话")
                            }
                        }
                    }
                }
            }
            item { androidx.compose.material3.TextButton(onClick = onConversation, modifier = Modifier.fillMaxWidth().padding(top = 9.dp)) { Text("回到这段对话") } }
    }
}

@Composable
fun NotesScreen(
    state: AppUiState,
    viewModel: AppViewModel,
    onOpenNote: (String) -> Unit,
    onAccount: () -> Unit,
    onConversation: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(query) { delay(260); viewModel.loadNotes(query) }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 22.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(0.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                PageHeading("你的书架", "手记", if (state.notes.isEmpty()) "和伴星整理过的内容，都会留在这里。" else "${state.notes.size} 篇 · 最近更新在前", modifier = Modifier.weight(1f))
                IconButton(onClick = { viewModel.loadNotes(query) }) { Icon(Icons.Filled.Refresh, "刷新手记", tint = StudyPalette.muted) }
                IconButton(onClick = onAccount) { Icon(Icons.Filled.AccountCircle, "我的账户", tint = StudyPalette.blueDeep) }
            }
        }
        item {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                placeholder = { Text("搜索标题与正文") },
                leadingIcon = { Icon(Icons.Filled.Search, null, tint = StudyPalette.muted) },
                shape = RoundedCornerShape(18.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = StudyPalette.paper,
                    unfocusedContainerColor = StudyPalette.paper,
                    focusedBorderColor = StudyPalette.blueDeep,
                    unfocusedBorderColor = StudyPalette.paperEdge,
                ),
            )
        }
        state.notesError?.let { error ->
            item {
                ConnectionFailureNotice(
                    title = "手记暂时没有接回来",
                    message = error,
                    retryLabel = "重新加载",
                    onRetry = { viewModel.loadNotes(query) },
                )
            }
        }
        if (state.isLoading && state.notes.isEmpty()) item {
            Row(Modifier.fillMaxWidth().padding(top = 68.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(22.dp), color = StudyPalette.blueDeep, strokeWidth = 2.dp)
                Text("正在找回手记", Modifier.padding(start = 10.dp), color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
            }
        } else if (state.notes.isEmpty() && state.notesError == null) item {
            Column(Modifier.fillMaxWidth().padding(top = 34.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Filled.Book, null, Modifier.size(28.dp), tint = StudyPalette.blueDeep)
                Text(if (query.isEmpty()) "书架还空着" else "没有找到这篇手记", Modifier.padding(top = 16.dp), color = StudyPalette.ink,
                    fontWeight = FontWeight.SemiBold, style = androidx.compose.material3.MaterialTheme.typography.titleMedium)
                Text(if (query.isEmpty()) "和伴星聊出的学习成果，可以整理成手记，之后随时回来继续。" else "试试更短的关键词，或检查一下拼写。",
                    Modifier.padding(top = 6.dp, start = 18.dp, end = 18.dp), color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
                if (query.isEmpty()) androidx.compose.material3.TextButton(onClick = onConversation, modifier = Modifier.padding(top = 8.dp)) {
                    Text("去对话里开始", color = StudyPalette.blueDeep)
                }
            }
        } else {
            if (query.isBlank()) {
                item {
                    Text("继续阅读", Modifier.padding(top = 20.dp, bottom = 8.dp),
                        color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold)
                    FeaturedNoteRow(state.notes.first(), onOpen = { onOpenNote(state.notes.first().id) })
                }
                if (state.notes.size > 1) item {
                    Text("其他手记", Modifier.padding(top = 22.dp, bottom = 4.dp),
                        color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold)
                }
            } else item {
                Text("搜索结果", Modifier.padding(top = 18.dp, bottom = 4.dp),
                    color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold)
            }
            itemsIndexed(state.notes, key = { _, note -> note.id }) { index, note ->
            LaunchedEffect(note.id, state.notes.size, state.isLoading, state.isLoadingMoreNotes, state.notesNextCursor, query) {
                if (index >= state.notes.size - 3 && !state.isLoading && !state.isLoadingMoreNotes) {
                    viewModel.loadMoreNotes(query)
                }
            }
            if (query.isNotBlank() || index > 0) {
            Column(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable { onOpenNote(note.id) }.padding(vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(note.title, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        note.snippet?.takeIf(String::isNotBlank)?.let { snippet ->
                            Text(snippet, Modifier.padding(top = 5.dp), color = StudyPalette.muted,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                                maxLines = 2, overflow = TextOverflow.Ellipsis)
                        }
                        Text("最近更新 · ${formatDate(note.updatedAt)}", Modifier.padding(top = 5.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Icon(Icons.Filled.ChevronRight, null, Modifier.padding(start = 12.dp).size(17.dp), tint = StudyPalette.muted)
                }
                if (index < state.notes.lastIndex) androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge.copy(alpha = .72f))
            }
            }
            }
        }
        if (state.isLoadingMoreNotes) item { CircularProgressIndicator(Modifier.fillMaxWidth().padding(12.dp).size(22.dp), color = StudyPalette.blueDeep) }
    }
}

@Composable
private fun FeaturedNoteRow(note: NoteSummary, onOpen: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).clickable(onClick = onOpen).padding(vertical = 11.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("最近更新 · ${formatDate(note.updatedAt)}", Modifier.weight(1f),
                color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
            Icon(Icons.Filled.ChevronRight, null, tint = StudyPalette.muted)
        }
        Text(note.title, color = StudyPalette.ink,
            style = androidx.compose.material3.MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold, lineHeight = 29.sp,
            maxLines = 3, overflow = TextOverflow.Ellipsis)
        note.snippet?.takeIf(String::isNotBlank)?.let { snippet ->
            Text(snippet, color = StudyPalette.muted,
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                lineHeight = 21.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteDetailScreen(
    noteId: String,
    state: AppUiState,
    viewModel: AppViewModel,
    onBack: () -> Unit,
    onAccount: () -> Unit,
    onContinue: (NoteDocument) -> Unit,
    onOpenFeature: (String) -> Unit,
) {
    LaunchedEffect(noteId) { viewModel.loadNote(noteId) }
    val document = state.noteDocument?.takeIf { it.id == noteId }
    var annotationTarget by remember(document?.versionId) { mutableStateOf<NoteBlock?>(null) }
    var pendingRemoval by remember { mutableStateOf<NoteAnnotation?>(null) }
    var actionsExpanded by rememberSaveable(noteId) { mutableStateOf(false) }
    val actionsSheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    LaunchedEffect(state.annotationStatus) {
        if (state.annotationStatus != null) annotationTarget = null
    }
    Column(Modifier.fillMaxSize().background(StudyPalette.paper)) {
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 25.dp, end = 25.dp, top = 3.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回手记", tint = StudyPalette.ink) }
                    Text("手记", Modifier.weight(1f), color = StudyPalette.ink, fontWeight = FontWeight.Medium)
                    IconButton(onClick = { actionsExpanded = true }) {
                        Icon(Icons.Filled.MoreVert, "手记操作", tint = StudyPalette.ink)
                    }
                    IconButton(onClick = onAccount) { Icon(Icons.Filled.AccountCircle, "我的账户", tint = StudyPalette.muted) }
                }
            }
            if (document == null) item {
                Column(Modifier.fillMaxWidth().padding(top = 45.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (state.noteError != null) {
                        ConnectionFailureNotice(
                            title = "这篇手记暂时打不开",
                            message = state.noteError,
                            retryLabel = "重新加载",
                            onRetry = { viewModel.loadNote(noteId) },
                        )
                    } else CircularProgressIndicator(Modifier.size(24.dp), color = StudyPalette.blueDeep)
                }
            } else {
                item {
                    Column(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 25.dp)) {
                        Eyebrow("拾星笔记  ·  第 ${document.versionNumber} 版")
                        Text(document.title, Modifier.padding(top = 9.dp), color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.SemiBold, lineHeight = 36.sp)
                        Text("长按段落，可以留下批注或请伴星讲解。", Modifier.padding(top = 9.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        androidx.compose.material3.HorizontalDivider(Modifier.padding(top = 19.dp), color = StudyPalette.paperEdge)
                    }
                }
                items(document.blocks) { block ->
                    NoteBlockRow(
                        block = block,
                        readingScale = state.readingScale,
                        viewModel = viewModel,
                        onAnnotate = { viewModel.clearAnnotationNotice(); annotationTarget = block },
                        onExplain = {
                            NoteAnnotationAnchor.wholeBlock(block, document.versionId)?.let {
                                viewModel.explainNoteAnnotation(noteId, it)
                            } ?: run {
                                viewModel.clearAnnotationNotice()
                                viewModel.reportAnnotationError("这段内容暂时无法精确对应到手记原文。")
                            }
                        },
                    )
                }
                if (state.annotationError != null || state.annotationStatus != null) item {
                    Row(Modifier.fillMaxWidth().padding(top = 13.dp), verticalAlignment = Alignment.Top) {
                        Icon(
                            if (state.annotationError != null) Icons.Filled.WarningAmber else Icons.Filled.CheckCircle,
                            contentDescription = null,
                            tint = if (state.annotationError != null) StudyPalette.danger else StudyPalette.success,
                            modifier = Modifier.padding(top = 2.dp).size(18.dp),
                        )
                        Text(state.annotationError ?: state.annotationStatus.orEmpty(), Modifier.weight(1f).padding(start = 8.dp),
                            color = if (state.annotationError != null) StudyPalette.danger else StudyPalette.success,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                    }
                }
                if (state.annotationError != null) item {
                    androidx.compose.material3.TextButton(onClick = { viewModel.retryNoteAnnotations(noteId) }) { Text("重新读取批注") }
                }
                if (state.noteAnnotations.isNotEmpty()) item {
                    Column(Modifier.fillMaxWidth().padding(top = 28.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                        Text("留在原文旁", Modifier.padding(top = 9.dp), color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                        Text("${state.noteAnnotations.size} 条批注与讲解", color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        state.noteAnnotations.forEach { annotation ->
                            androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                            Text("“${annotation.anchor.excerpt}”", color = StudyPalette.ink,
                                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, maxLines = 5, overflow = TextOverflow.Ellipsis)
                            Text(annotation.explanation, color = StudyPalette.muted,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                            Text(if (annotation.versionState == "current") "对应当前版本" else "来自较早版本",
                                color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                androidx.compose.material3.TextButton(
                                    enabled = !state.isAnnotationBusy && annotation.versionState == "current",
                                    onClick = { viewModel.explainNoteAnnotation(noteId, annotation.anchor) },
                                ) { Text("再讲一次") }
                                androidx.compose.material3.TextButton(
                                    enabled = !state.isAnnotationBusy,
                                    onClick = { pendingRemoval = annotation },
                                ) { Text("撤下", color = StudyPalette.muted) }
                            }
                        }
                    }
                }
            }
        }
        if (document != null) {
            androidx.compose.material3.Button(
                onClick = { onContinue(document) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 9.dp).height(50.dp),
                shape = RoundedCornerShape(15.dp),
            ) { Text("在对话里继续提问") }
        }
    }
    if (actionsExpanded) {
        ModalBottomSheet(
            onDismissRequest = { actionsExpanded = false },
            sheetState = actionsSheetState,
            containerColor = StudyPalette.paper,
            contentColor = StudyPalette.ink,
        ) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 22.dp).padding(bottom = 24.dp)) {
                Text("这篇手记", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold)
                listOf("overview" to "速览", "mindmap" to "脑图", "explain" to "讲解", "versions" to "版本记录").forEachIndexed { index, (kind, label) ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable {
                            actionsExpanded = false
                            onOpenFeature(kind)
                        },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(label, Modifier.weight(1f), color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge)
                        Icon(Icons.Filled.ChevronRight, contentDescription = null, tint = StudyPalette.muted)
                    }
                    if (index < 3) androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                }
            }
        }
    }
    annotationTarget?.let { target ->
        val anchor = NoteAnnotationAnchor.wholeBlock(target, document?.versionId.orEmpty())
        if (anchor != null) NoteAnnotationComposer(
            block = target,
            busy = state.isAnnotationBusy,
            error = state.annotationError,
            onDismiss = { if (!state.isAnnotationBusy) annotationTarget = null },
            onSave = { explanation -> viewModel.saveNoteAnnotation(noteId, anchor, explanation) },
            onExplain = { viewModel.explainNoteAnnotation(noteId, anchor) },
        )
    }
    pendingRemoval?.let { annotation ->
        AlertDialog(
            onDismissRequest = { pendingRemoval = null },
            title = { Text("撤下这条批注？") },
            text = { Text("已生成的原文讲解也会一并移除；对话记录不会删除。") },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    pendingRemoval = null
                    viewModel.removeNoteAnnotation(noteId, annotation)
                }) { Text("撤下", color = StudyPalette.danger) }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { pendingRemoval = null }) { Text("保留") } },
        )
    }
}

@Composable
private fun NoteBlockRow(
    block: NoteBlock,
    readingScale: Float,
    viewModel: AppViewModel,
    onAnnotate: () -> Unit,
    onExplain: () -> Unit,
) {
    var menuExpanded by rememberSaveable(block.ordinal) { mutableStateOf(false) }
    val actionable = block.type in setOf("paragraph", "heading", "quote", "code", "list")
    Box(Modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().then(
                if (actionable) Modifier.combinedClickable(
                    onClick = {},
                    onLongClickLabel = "段落操作",
                    onLongClick = { menuExpanded = true },
                ) else Modifier,
            ),
        ) { NoteBlockView(block, readingScale, viewModel) }
        if (actionable) androidx.compose.material3.DropdownMenu(
            expanded = menuExpanded,
            onDismissRequest = { menuExpanded = false },
            shape = RoundedCornerShape(15.dp),
            containerColor = StudyPalette.paper,
            tonalElevation = 0.dp,
            shadowElevation = 3.dp,
        ) {
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("给这一段留批注") },
                onClick = { menuExpanded = false; onAnnotate() },
            )
            androidx.compose.material3.DropdownMenuItem(
                text = { Text("请伴星讲解") },
                onClick = { menuExpanded = false; onExplain() },
            )
        }
    }
}

@Composable
private fun NoteBlockView(block: NoteBlock, readingScale: Float = 1f, viewModel: AppViewModel) {
    when (block.type) {
        "heading" -> Text(
            block.content.replace(Regex("^\\s*<h[1-6]\\b[^>]*>|</h[1-6]>\\s*$", RegexOption.IGNORE_CASE), "")
                .replace(Regex("^\\s*#{1,6}\\s+"), ""),
            color = StudyPalette.ink,
            style = androidx.compose.material3.MaterialTheme.typography.titleLarge.copy(
                fontSize = androidx.compose.material3.MaterialTheme.typography.titleLarge.fontSize * readingScale,
            ),
            fontWeight = FontWeight.SemiBold,
        )
        "quote" -> Row(verticalAlignment = Alignment.Top) {
            Spacer(Modifier.padding(end = 10.dp).size(width = 3.dp, height = 42.dp).background(StudyPalette.blue.copy(alpha = .65f), RoundedCornerShape(2.dp)))
            Text(
                block.content.replace(Regex("(?m)^\\s*>\\s?"), ""),
                color = StudyPalette.muted,
                style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                    fontSize = androidx.compose.material3.MaterialTheme.typography.bodyLarge.fontSize * readingScale,
                    lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.28f * readingScale,
                ),
            )
        }
        "code" -> Box(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(androidx.compose.material3.MaterialTheme.colorScheme.surfaceVariant)
                .horizontalScroll(rememberScrollState()),
        ) {
            Text(
                block.content,
                Modifier.padding(13.dp),
                color = StudyPalette.ink,
                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium.copy(
                    fontSize = androidx.compose.material3.MaterialTheme.typography.bodyMedium.fontSize * readingScale,
                ),
                fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace,
                softWrap = false,
            )
        }
        "image" -> NoteImageBlock(block, viewModel)
        "list" -> {
            val lines = noteListLines(block.content)
            val ordered = Regex("^\\s*\\d+[.)]\\s+").containsMatchIn(block.content.lineSequence().firstOrNull().orEmpty())
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                lines.forEachIndexed { index, line ->
                    Row(verticalAlignment = Alignment.Top) {
                        Text(if (ordered) "${index + 1}." else "•", Modifier.padding(end = 9.dp), color = StudyPalette.blueDeep, fontWeight = FontWeight.SemiBold)
                        Text(line, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(
                            fontSize = androidx.compose.material3.MaterialTheme.typography.bodyLarge.fontSize * readingScale,
                            lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.28f * readingScale,
                        ))
                    }
                }
            }
        }
        "table" -> {
            val rows = noteTableRows(block.content)
            Column(Modifier.fillMaxWidth().background(StudyPalette.inset.copy(alpha = .72f), RoundedCornerShape(14.dp)).padding(horizontal = 10.dp)) {
                rows.forEachIndexed { rowIndex, cells ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        cells.forEach { cell ->
                            Text(
                                cell,
                                Modifier.weight(1f),
                                color = if (rowIndex == 0) StudyPalette.ink else StudyPalette.muted,
                                fontWeight = if (rowIndex == 0) FontWeight.SemiBold else FontWeight.Normal,
                                style = androidx.compose.material3.MaterialTheme.typography.bodySmall.copy(
                                    fontSize = androidx.compose.material3.MaterialTheme.typography.bodySmall.fontSize * readingScale,
                                ),
                            )
                        }
                    }
                    if (rowIndex < rows.lastIndex) androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                }
            }
        }
        else -> Text(block.content, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(fontSize = androidx.compose.material3.MaterialTheme.typography.bodyLarge.fontSize * readingScale, lineHeight = androidx.compose.material3.MaterialTheme.typography.bodyLarge.lineHeight * 1.28f * readingScale))
    }
}

private fun noteListLines(content: String): List<String> = content.lineSequence().filter(String::isNotBlank).map {
    it.replace(Regex("^\\s*(?:[-+*]|\\d+[.)])\\s+"), "")
}.toList()

private fun noteTableRows(content: String): List<List<String>> = content.lineSequence().mapNotNull { line ->
    val cells = line.split('|').map(String::trim).let { row ->
        row.dropWhile(String::isEmpty).dropLastWhile(String::isEmpty)
    }
    if (cells.isEmpty() || cells.all { Regex("^:?-{2,}:?$").matches(it) }) null else cells
}.toList()

@Composable
private fun NoteAnnotationComposer(
    block: NoteBlock,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSave: (String) -> Unit,
    onExplain: () -> Unit,
) {
    var draft by rememberSaveable(block.ordinal) { mutableStateOf("") }
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Surface(shape = RoundedCornerShape(26.dp), color = StudyPalette.paper, tonalElevation = 4.dp) {
            Column(
                Modifier.fillMaxWidth().widthIn(max = 440.dp).imePadding().padding(21.dp),
                verticalArrangement = Arrangement.spacedBy(13.dp),
            ) {
                Eyebrow("这段原文")
                Text(block.content.take(500), color = StudyPalette.ink,
                    style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, maxLines = 8, overflow = TextOverflow.Ellipsis)
                Text("操作会绑定整段原文和当前手记版本。", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = draft,
                    onValueChange = { draft = it },
                    modifier = Modifier.fillMaxWidth(),
                    placeholder = { Text("记下你的理解、疑问或提醒") },
                    minLines = 3,
                    maxLines = 6,
                    shape = RoundedCornerShape(15.dp),
                    enabled = !busy,
                )
                if (error != null) Text(error, color = StudyPalette.danger,
                    style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                if (busy) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = StudyPalette.blueDeep)
                    Text("正在保存或生成…", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.material3.TextButton(onClick = onDismiss, enabled = !busy) { Text("取消") }
                    androidx.compose.material3.TextButton(onClick = onExplain, enabled = !busy) { Text("请伴星讲解") }
                    androidx.compose.material3.Button(onClick = { onSave(draft) }, enabled = !busy && draft.isNotBlank()) { Text("留下批注") }
                }
            }
        }
    }
}

private data class NoteImageReference(val source: String, val alt: String)

private fun noteImageReference(content: String): NoteImageReference? {
    val markdown = Regex("!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+\"[^\"]*\")?\\)").find(content)
    if (markdown != null) return NoteImageReference(markdown.groupValues[2], markdown.groupValues[1])
    val tag = Regex("<img\\b[^>]*>", RegexOption.IGNORE_CASE).find(content)?.value ?: return null
    fun attribute(name: String): String? = Regex("\\b$name\\s*=\\s*(['\"])(.*?)\\1", RegexOption.IGNORE_CASE)
        .find(tag)?.groupValues?.get(2)
    val source = attribute("src")?.takeIf(String::isNotBlank) ?: return null
    return NoteImageReference(source, attribute("alt").orEmpty())
}

@Composable
private fun NoteImageBlock(block: NoteBlock, viewModel: AppViewModel) {
    val reference = remember(block.content) { noteImageReference(block.content) }
    var bitmap by remember(reference?.source) { mutableStateOf<Bitmap?>(null) }
    var loading by remember(reference?.source) { mutableStateOf(false) }
    var failed by remember(reference?.source) { mutableStateOf(false) }
    var retry by remember { mutableStateOf(0) }
    LaunchedEffect(reference?.source, retry) {
        val source = reference?.source ?: return@LaunchedEffect
        loading = true
        failed = false
        try {
            val bytes = viewModel.imageBytes(source)
            bitmap = bytes?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            failed = bitmap == null
        } catch (_: Throwable) {
            bitmap = null
            failed = true
        } finally {
            loading = false
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(
            Modifier.fillMaxWidth().heightIn(min = 100.dp, max = 420.dp)
                .clip(RoundedCornerShape(16.dp)).background(StudyPalette.inset),
            contentAlignment = Alignment.Center,
        ) {
            when {
                bitmap != null -> Image(
                    bitmap!!.asImageBitmap(),
                    contentDescription = reference?.alt?.ifBlank { "手记中的图片" } ?: "手记中的图片",
                    modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
                    contentScale = ContentScale.Fit,
                )
                loading -> CircularProgressIndicator(Modifier.size(22.dp), color = StudyPalette.blueDeep)
                else -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(
                        if (reference == null) "图片地址无法读取" else if (failed) "图片暂时无法打开" else "手记配图",
                        color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
                    )
                    if (reference != null && failed) {
                        androidx.compose.material3.TextButton(onClick = { retry += 1 }) { Text("重新加载") }
                    }
                }
            }
        }
        reference?.alt?.takeIf(String::isNotBlank)?.let {
            Text(it, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
        }
    }
}


@Composable
fun AccountScreen(state: AppUiState, viewModel: AppViewModel, onBack: () -> Unit, onSettings: () -> Unit, onCompanion: () -> Unit) {
    var address by rememberSaveable(state.serviceAddress) { mutableStateOf(state.serviceAddress) }
    var displayName by rememberSaveable(state.profile?.displayName) { mutableStateOf(state.profile?.displayName.orEmpty()) }
    var policy by remember(state.aiSettings) {
        mutableStateOf(state.aiSettings?.dataPolicy ?: AIDataPolicy(false, false, true, true))
    }
    var savedPolicy by remember(state.aiSettings) {
        mutableStateOf(state.aiSettings?.dataPolicy ?: AIDataPolicy(false, false, true, true))
    }
    var consentAccepted by rememberSaveable { mutableStateOf(false) }
    var workspaceMenuOpen by remember { mutableStateOf(false) }
    var showAdvancedService by rememberSaveable { mutableStateOf(false) }
    var avatarBitmap by remember(state.profile?.avatarUrl) { mutableStateOf<Bitmap?>(null) }
    val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        uri?.let(viewModel::saveAvatar)
    }
    LaunchedEffect(Unit) { viewModel.loadAccountSettings() }
    LaunchedEffect(state.aiSettings?.dataPolicy) {
        state.aiSettings?.dataPolicy?.let {
            policy = it
            savedPolicy = it
        }
    }
    LaunchedEffect(state.profile?.avatarUrl) {
        val address = state.profile?.avatarUrl ?: return@LaunchedEffect
        avatarBitmap = runCatching {
            viewModel.imageBytes(address)?.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        }.getOrNull()
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 20.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = StudyPalette.ink) }
                PageHeading("你的随身书房", "我的", state.profile?.workspaceName ?: "账户、设备与数据偏好。", modifier = Modifier.weight(1f))
            }
        }
        state.accountError?.let { error ->
            item { AccountMessage(error, isError = true) }
        }
        state.accountNotice?.let { notice ->
            item { AccountMessage(notice, isError = false) }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                Text("账号", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                PaperSurface(Modifier.fillMaxWidth(), padding = 16.dp) {
                    Column(verticalArrangement = Arrangement.spacedBy(13.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(
                                Modifier.size(58.dp).clip(CircleShape).background(StudyPalette.sky)
                                    .clickable(enabled = !state.isAccountBusy) {
                                        avatarPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (avatarBitmap != null) {
                                    Image(avatarBitmap!!.asImageBitmap(), "账户头像", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                                } else {
                                    Text(
                                        (state.profile?.displayName?.firstOrNull() ?: state.profile?.email?.firstOrNull() ?: '阅').uppercase(),
                                        color = StudyPalette.blueDeep,
                                        style = androidx.compose.material3.MaterialTheme.typography.titleMedium,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                }
                            }
                            Text(if (state.isAccountBusy) "上传中" else "更换头像", color = StudyPalette.blueDeep,
                                style = androidx.compose.material3.MaterialTheme.typography.labelSmall)
                        }
                        Column(Modifier.weight(1f).padding(start = 12.dp)) {
                            val email = state.profile?.email.orEmpty()
                            Text(
                                email,
                                modifier = Modifier.fillMaxWidth().semantics { contentDescription = email },
                                color = StudyPalette.ink,
                                style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(state.profile?.workspaceName ?: "我的书房", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        }
                    }
                    androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                    SoftTextField(displayName, { displayName = it.take(32) }, "显示称呼")
                    Text("最多 32 个字符。清空后会使用邮箱前缀作为称呼。", color = StudyPalette.muted,
                        style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                    androidx.compose.material3.Button(
                        onClick = { viewModel.saveProfile(displayName) },
                        enabled = !state.isAccountBusy && displayName.trim() != state.profile?.displayName.orEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(16.dp),
                    ) {
                        if (state.isAccountBusy) CircularProgressIndicator(Modifier.size(17.dp), strokeWidth = 2.dp)
                        else Text(if (displayName.isBlank()) "清除称呼" else "保存称呼")
                    }
                    }
            }
        }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("书房与伴星", color = StudyPalette.muted,
                    style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                if (state.workspaces.size > 1) {
                    Box(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                        androidx.compose.material3.OutlinedButton(
                            onClick = { workspaceMenuOpen = true },
                            modifier = Modifier.fillMaxWidth(),
                            shape = RoundedCornerShape(15.dp),
                        ) {
                            Icon(Icons.Filled.Book, contentDescription = null, tint = StudyPalette.blueDeep)
                            Text(state.profile?.workspaceName ?: "选择书房", Modifier.weight(1f).padding(start = 8.dp))
                            Text("⌄", color = StudyPalette.muted)
                        }
                        androidx.compose.material3.DropdownMenu(
                            expanded = workspaceMenuOpen,
                            onDismissRequest = { workspaceMenuOpen = false },
                            shape = RoundedCornerShape(15.dp),
                            containerColor = StudyPalette.paper,
                            tonalElevation = 0.dp,
                            shadowElevation = 3.dp,
                        ) {
                            state.workspaces.forEach { workspace ->
                                androidx.compose.material3.DropdownMenuItem(
                                    text = { Text(if (workspace.id == state.profile?.workspaceId) "✓  ${workspace.name}" else workspace.name) },
                                    onClick = { workspaceMenuOpen = false; viewModel.switchWorkspace(workspace) },
                                )
                            }
                        }
                    }
                    Text("切换书房会重新接回该空间的对话与手记。", Modifier.padding(start = 2.dp, top = 3.dp),
                        color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                }
                Row(Modifier.fillMaxWidth().padding(vertical = 13.dp), verticalAlignment = Alignment.Top) {
                    Icon(Icons.Filled.Inbox, null, Modifier.padding(top = 2.dp).size(19.dp), tint = StudyPalette.muted)
                    Column(Modifier.weight(1f).padding(start = 12.dp)) {
                        Text("伴星操作权限", color = StudyPalette.ink,
                            style = androidx.compose.material3.MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        Text(permissionDescription(state.companionPermissionLevel), Modifier.padding(top = 3.dp), color = StudyPalette.muted,
                            style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 20.sp)
                        if (state.companionPermissionLevel == null) {
                            androidx.compose.material3.TextButton(onClick = { viewModel.loadAccountSettings() }, enabled = !state.isAccountBusy,
                                contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp)) { Text("重新读取") }
                        }
                    }
                }
                androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                Column {
                    AccountSubpageRow("使用设置", "字号、对话显示与动效", onClick = onSettings)
                    androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                    AccountSubpageRow("伴星中心", "回到同一段交流，查看她的状态", onClick = onCompanion)
                }
            }
        }
        val settings = state.aiSettings
        if (settings != null) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("AI 与数据", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    Text("你可以控制哪些内容发送到外部服务。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (settings.requiresConsent && settings.consentVersion == null) {
                            Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text("阅读《AI 使用协议》", color = StudyPalette.ink, fontWeight = FontWeight.SemiBold)
                                    Text("使用外部 AI 时，完成任务所需的手记、回答、对话或图片可能发送到模型服务；语音讲解也会将讲解文字交给外部语音服务。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, lineHeight = 22.sp)
                                    Text("同意由你本人签署，对你的账号生效。签署前，需要授权的外部 AI 调用不会执行。生成内容可能有误，请结合原文核对。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall, lineHeight = 20.sp)
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        androidx.compose.material3.Checkbox(
                                            checked = consentAccepted,
                                            onCheckedChange = { consentAccepted = it },
                                            enabled = !state.isAccountBusy,
                                        )
                                        Text("我已阅读并同意《AI 使用协议》", color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                                    }
                                    androidx.compose.material3.Button(
                                        onClick = viewModel::acceptAIConsent,
                                        enabled = !state.isAccountBusy && consentAccepted,
                                        modifier = Modifier.fillMaxWidth(),
                                        shape = RoundedCornerShape(16.dp),
                                    ) {
                                        Text("同意并开启外部 AI")
                                    }
                            }
                        } else if (settings.consentVersion != null) {
                            Text("✓  已签署 ${settings.consentVersion}${settings.consentAt?.take(10)?.let { " · $it" }.orEmpty()}", color = StudyPalette.success, style = androidx.compose.material3.MaterialTheme.typography.labelMedium)
                        } else {
                            Text("当前服务未启用外部 AI，无需签署。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                        }
                        androidx.compose.material3.HorizontalDivider(color = StudyPalette.paperEdge)
                        PolicySwitch("允许使用外部 AI 服务", "允许将任务所需内容发送到模型服务。", policy.sendToExternal,
                            enabled = !state.isAccountBusy && (!settings.requiresConsent || settings.consentVersion != null)) { policy = policy.copy(sendToExternal = it) }
                        PolicySwitch("允许发送图片内容", "图片不会脱离这项设置单独授权。", policy.sendImageContent) { policy = policy.copy(sendImageContent = it) }
                        PolicySwitch("启用个人信息识别", "在请求处理中识别可能的个人信息。", policy.piiDetection) { policy = policy.copy(piiDetection = it) }
                        PolicySwitch("记录 AI 调用审计", "保留服务调用的审计记录。", policy.auditLogging) { policy = policy.copy(auditLogging = it) }
                        androidx.compose.material3.OutlinedButton(
                            onClick = { viewModel.saveAIDataPolicy(policy) },
                            enabled = !state.isAccountBusy && policy != savedPolicy,
                            modifier = Modifier.align(Alignment.End),
                            shape = RoundedCornerShape(16.dp),
                        ) { Text("保存数据偏好", color = StudyPalette.blueDeep) }
                    }
            }
            }
        } else if (state.isAccountBusy) {
            item { CircularProgressIndicator(Modifier.padding(22.dp).size(24.dp), color = StudyPalette.blueDeep) }
        }
        item {
            Column {
                androidx.compose.material3.TextButton(
                    onClick = { showAdvancedService = !showAdvancedService },
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 0.dp),
                ) { Text(if (showAdvancedService) "收起开发与服务" else "开发与服务") }
                if (showAdvancedService) {
                    PaperSurface(Modifier.fillMaxWidth(), padding = 16.dp) {
                        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
                            Text("服务地址", color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Text("仅在自建服务时修改。保存后会退出当前会话。", color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
                            SoftTextField(address, { address = it }, "https://study.example.com", keyboardType = KeyboardType.Uri)
                            androidx.compose.material3.OutlinedButton(onClick = { viewModel.updateServiceAddress(address) }, enabled = address.isNotBlank(), modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp)) {
                                Text("保存并重新登录", color = StudyPalette.blueDeep)
                            }
                        }
                    }
                    }
            }
        }
        item {
            androidx.compose.material3.TextButton(onClick = { viewModel.logout() }, modifier = Modifier.fillMaxWidth().padding(top = 0.dp)) {
                Text("退出登录", color = StudyPalette.danger)
            }
        }
    }
}

@Composable
private fun PolicySwitch(title: String, detail: String, checked: Boolean, enabled: Boolean = true, onCheckedChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 10.dp)) {
            Text(title, color = StudyPalette.ink, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
            Text(detail, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.bodySmall)
        }
        androidx.compose.material3.Switch(checked = checked, onCheckedChange = onCheckedChange, enabled = enabled)
    }
}

@Composable
private fun AccountMessage(message: String, isError: Boolean) {
    NoticeSurface(Modifier.fillMaxWidth()) {
        Text(
            (if (isError) "!  " else "✓  ") + message,
            color = if (isError) StudyPalette.danger else StudyPalette.success,
            style = androidx.compose.material3.MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun SoftTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    password: Boolean = false,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        visualTransformation = if (password) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        shape = RoundedCornerShape(14.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = StudyPalette.paper,
            unfocusedContainerColor = StudyPalette.paper,
            focusedBorderColor = StudyPalette.blue.copy(alpha = .55f),
            unfocusedBorderColor = StudyPalette.paperEdge,
        ),
    )
}

@Composable
private fun Eyebrow(value: String) {
    Text(value, color = StudyPalette.muted, style = androidx.compose.material3.MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
}

private fun formatDate(value: String): String = runCatching {
    java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString()
}.getOrDefault("最近更新")

private fun permissionDescription(level: String?): String = when (level) {
    "read_only" -> "需要写入或执行操作时，伴星会先给你预览并征求确认。"
    "full" -> "已授权范围内的可逆操作可以直接执行；不可逆操作仍需你确认。"
    "guided" -> "伴星会先说明下一步，再等你确认后执行。"
    else -> "暂时没有读取到权限信息。"
}
