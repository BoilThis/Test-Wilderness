package com.example

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.SoundPool
import android.util.Log
import java.io.File
import java.util.concurrent.Executors
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Eco
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Water
import androidx.compose.material.icons.filled.Whatshot
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.example.ui.theme.MyApplicationTheme

class MainActivity : ComponentActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    enableEdgeToEdge()
    setContent {
      MyApplicationTheme {
        WildernessSurvivalApp()
      }
    }
  }
}

private object GameSfx {
  private const val TAG = "SylvanSfx"
  private val sfxExecutor = Executors.newSingleThreadExecutor()
  private var pool: SoundPool? = null
  private var appContext: Context? = null
  private val ids = HashMap<String, Int>()
  private val names = HashMap<Int, String>()
  private val ready = HashSet<Int>()
  private val descriptors = HashMap<Int, android.content.res.AssetFileDescriptor>()
  private val pending = HashMap<String, Pair<Float, Float>>()
  private val loopStream = HashMap<String, Int>()
  private val loopWant = HashMap<String, Float>()
  private val beds = HashMap<String, MediaPlayer>()
  private val bedWant = HashMap<String, Float>()
  private val bedNames = setOf("ocean", "windbed", "wadebed", "under", "cave", "rain", "firebed", "hull")

  fun warm(context: Context) {
    val appCtx = context.applicationContext
    sfxExecutor.execute {
      ensurePool(appCtx)
      val listed = try {
        appCtx.assets.list("wilderness/audio")
      } catch (_: Exception) {
        null
      } ?: return@execute
      for (file in listed) {
        if (file.endsWith(".wav")) loadOne(file.removeSuffix(".wav"))
      }
    }
  }

  fun play(context: Context, name: String, volume: Double, rate: Double) {
    val appCtx = context.applicationContext
    val vol = volume.toFloat().coerceIn(0f, 1f)
    val spd = rate.toFloat().coerceIn(0.5f, 2f)
    sfxExecutor.execute {
      ensurePool(appCtx)
      val id = ids[name]
      if (id == null || !ready.contains(id)) {
        if (id == null) loadOne(name)
        pending[name] = vol to spd
        return@execute
      }
      pool?.play(id, vol, vol, 1, 0, spd)
    }
  }

  fun loop(context: Context, name: String, volume: Double) {
    val appCtx = context.applicationContext
    val vol = volume.toFloat().coerceIn(0f, 1f)
    if (bedNames.contains(name)) {
      sfxExecutor.execute {
        appContext = appCtx
        applyBed(name, vol)
      }
      return
    }
    sfxExecutor.execute {
      ensurePool(appCtx)
      loopWant[name] = vol
      val id = ids[name]
      if (id == null || !ready.contains(id)) {
        if (id == null) loadOne(name)
        return@execute
      }
      applyLoop(name, id, vol)
    }
  }

  private fun applyBed(name: String, vol: Float) {
    bedWant[name] = vol
    val existing = beds[name]
    if (existing == null) {
      if (vol < 0.01f) return
      val context = appContext ?: return
      val created = MediaPlayer()
      try {
        val afd = context.assets.openFd("wilderness/audio/$name.ogg")
        created.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
        afd.close()
      } catch (err: Exception) {
        Log.e(TAG, "bed $name", err)
        created.release()
        return
      }
      created.setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_GAME)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build()
      )
      created.isLooping = true
      created.setVolume(vol, vol)
      created.setOnPreparedListener { player ->
        sfxExecutor.execute {
          val want = bedWant[name] ?: vol
          player.setVolume(want, want)
          if (want >= 0.01f) player.start()
        }
      }
      beds[name] = created
      created.prepareAsync()
      return
    }
    try {
      existing.setVolume(vol, vol)
      if (vol < 0.01f) {
        if (existing.isPlaying) existing.pause()
      } else if (!existing.isPlaying) {
        existing.start()
      }
    } catch (_: Exception) {
    }
  }

  private fun ensurePool(context: Context) {
    if (pool != null) return
    appContext = context
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_GAME)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    val created = SoundPool.Builder().setMaxStreams(12).setAudioAttributes(attrs).build()
    created.setOnLoadCompleteListener { _, sampleId, status ->
      sfxExecutor.execute {
        descriptors.remove(sampleId)?.close()
        if (status != 0) {
          Log.e(TAG, "sound $sampleId failed to load ($status)")
          return@execute
        }
        ready.add(sampleId)
        val name = names[sampleId] ?: return@execute
        pending.remove(name)?.let { (vol, spd) ->
          created.play(sampleId, vol, vol, 1, 0, spd)
        }
        loopWant[name]?.let { applyLoop(name, sampleId, it) }
      }
    }
    pool = created
  }

  private fun loadOne(name: String) {
    if (ids.containsKey(name)) return
    val context = appContext ?: return
    val created = pool ?: return
    try {
      val afd = context.assets.openFd("wilderness/audio/$name.wav")
      val id = created.load(afd, 1)
      if (id == 0) {
        afd.close()
        Log.e(TAG, "SoundPool rejected $name")
        return
      }
      descriptors[id] = afd
      ids[name] = id
      names[id] = name
    } catch (err: Exception) {
      Log.e(TAG, "open $name", err)
      try {
        val out = File(context.cacheDir, "sfx-$name.wav")
        if (!out.exists()) {
          context.assets.open("wilderness/audio/$name.wav").use { input ->
            out.outputStream().use { input.copyTo(it) }
          }
        }
        val id = created.load(out.absolutePath, 1)
        if (id != 0) {
          ids[name] = id
          names[id] = name
        }
      } catch (again: Exception) {
        Log.e(TAG, "cache $name", again)
      }
    }
  }

  private fun applyLoop(name: String, id: Int, vol: Float) {
    val created = pool ?: return
    val stream = loopStream[name] ?: 0
    if (stream == 0) {
      if (vol < 0.01f) return
      val played = created.play(id, vol, vol, 2, -1, 1f)
      if (played != 0) loopStream[name] = played
      return
    }
    created.setVolume(stream, vol, vol)
    if (vol < 0.01f) created.pause(stream) else created.resume(stream)
  }
}

class WebAppInterface(private val context: Context) {
  init {
    GameSfx.warm(context)
  }

  @JavascriptInterface
  fun triggerHaptic(durationMs: Long) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
        val vibrator = vibratorManager?.defaultVibrator
        vibrator?.vibrate(VibrationEffect.createOneShot(durationMs, VibrationEffect.DEFAULT_AMPLITUDE))
      } else {
        @Suppress("DEPRECATION")
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        @Suppress("DEPRECATION")
        vibrator?.vibrate(durationMs)
      }
    } catch (_: Exception) {
      // Graceful fallback
    }
  }

  @JavascriptInterface
  fun playAsset(name: String, volume: Double, rate: Double) {
    GameSfx.play(context, name, volume, rate)
  }

  @JavascriptInterface
  fun setLoopVolume(name: String, volume: Double) {
    GameSfx.loop(context, name, volume)
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WildernessSurvivalApp() {
  val lifecycleOwner = LocalLifecycleOwner.current
  var showGuideDialog by remember { mutableStateOf(false) }
  // Plain non-Compose ref holders prevent triggering a redundant recomposition / SurfaceSyncGroup pass
  val containerHolder = remember { arrayOfNulls<FrameLayout>(1) }
  val webViewHolder = remember { arrayOfNulls<WebView>(1) }
  var webViewKey by remember { mutableIntStateOf(0) }
  var webViewPageReady by remember { mutableStateOf(false) }
  var renderCrashCount by remember { mutableIntStateOf(0) }
  var webViewCrashMessage by remember { mutableStateOf<String?>(null) }

  BackHandler(enabled = showGuideDialog) {
    showGuideDialog = false
  }

  // Stage Chromium WebView initialization well after MainActivity's initial WindowManager SurfaceSyncGroup (#0/#1) finishes,
  // and instantiate WebView while detached so cold native provider loading cannot block an active ViewRootImpl transaction.
  LaunchedEffect(webViewKey) {
    webViewPageReady = false
    withFrameNanos { }
    withFrameNanos { }
    delay(if (webViewKey == 0) 1250L else 180L)
    val host = containerHolder[0] ?: return@LaunchedEffect
    if (!host.isAttachedToWindow || webViewHolder[0] != null) return@LaunchedEffect

    val ctx = host.context
    val wv = WebView(ctx).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
      setBackgroundColor(android.graphics.Color.rgb(4, 10, 14))

      settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = true
        allowContentAccess = true
        @Suppress("DEPRECATION")
        allowFileAccessFromFileURLs = true
        @Suppress("DEPRECATION")
        allowUniversalAccessFromFileURLs = true
        useWideViewPort = true
        loadWithOverviewMode = true
        mediaPlaybackRequiresUserGesture = false
        cacheMode = WebSettings.LOAD_DEFAULT
      }

      webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
          Log.d("SylvanWeb", "${consoleMessage?.message()} -- line ${consoleMessage?.lineNumber()} of ${consoleMessage?.sourceId()}")
          return true
        }
      }

      webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
          super.onPageFinished(view, url)
          webViewPageReady = true
          Log.d("SylvanWeb", "Wilderness page loaded: $url")
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
          val crashed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            detail?.didCrash() == true
          } else true
          Log.e("SylvanWeb", "WebView render process gone (didCrash=$crashed, attempt=$renderCrashCount)")
          if (renderCrashCount < 1) {
            renderCrashCount += 1
            webViewKey += 1
          } else {
            webViewCrashMessage = if (crashed) {
              "The 3D WebGL graphics process stopped unexpectedly."
            } else {
              "The Android WebView renderer ran low on graphics memory."
            }
          }
          return true
        }
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
      }

      addJavascriptInterface(WebAppInterface(ctx), "AndroidBridge")
    }
    webViewHolder[0] = wv

    // Let main looper settle after Chromium cold-start before attaching child view and loading WebGL page
    withFrameNanos { }
    if (!host.isAttachedToWindow || webViewHolder[0] !== wv) return@LaunchedEffect
    host.addView(wv)

    withFrameNanos { }
    if (webViewHolder[0] === wv && wv.isAttachedToWindow) {
      wv.loadUrl("file:///android_asset/wilderness/index.html")
    }
  }

  DisposableEffect(lifecycleOwner, webViewKey) {
    val observer = LifecycleEventObserver { _, event ->
      val wv = webViewHolder[0] ?: return@LifecycleEventObserver
      when (event) {
        Lifecycle.Event.ON_RESUME -> {
          wv.onResume()
          wv.resumeTimers()
        }
        Lifecycle.Event.ON_PAUSE -> {
          wv.onPause()
        }
        else -> Unit
      }
    }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
      containerHolder[0] = null
      val wv = webViewHolder[0]
      webViewHolder[0] = null
      wv?.apply {
        stopLoading()
        (parent as? ViewGroup)?.removeView(this)
        destroy()
      }
    }
  }

  Scaffold(
    modifier = Modifier
      .fillMaxSize()
      .testTag("wilderness_scaffold"),
    containerColor = Color(0xFF040A0E)
  ) { _ ->
    Box(
      modifier = Modifier
        .fillMaxSize()
        .testTag("wilderness_container")
    ) {
      // 1. Mount lightweight FrameLayout immediately on Frame 1 so Compose tree never structurally swaps during launch
      key(webViewKey) {
        AndroidView(
          factory = { ctx ->
            FrameLayout(ctx).apply {
              layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
              )
              setBackgroundColor(android.graphics.Color.rgb(4, 10, 14))
              containerHolder[0] = this
            }
          },
          modifier = Modifier
            .fillMaxSize()
            .testTag("wilderness_webview")
        )
      }

      if (!webViewPageReady && webViewCrashMessage == null) {
        Box(
          modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF040A0E)),
          contentAlignment = Alignment.Center
        ) {
          Text(
            text = "Preparing Sylvan 3D Archipelago...",
            color = Color(0xFF26E6C6),
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold
          )
        }
      }

      if (webViewCrashMessage != null) {
        Box(
          modifier = Modifier
            .fillMaxSize()
            .background(Color(0xEE050B10)),
          contentAlignment = Alignment.Center
        ) {
          Card(
            modifier = Modifier
              .fillMaxWidth()
              .padding(24.dp)
              .testTag("webview_recovery_card"),
            shape = RoundedCornerShape(24.dp),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF0A141D)),
            border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x6626E6C6))
          ) {
            Column(
              modifier = Modifier.padding(24.dp),
              horizontalAlignment = Alignment.CenterHorizontally
            ) {
              Text(
                text = "3D Engine Recovery",
                color = Color(0xFF26E6C6),
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold
              )
              Spacer(modifier = Modifier.height(10.dp))
              Text(
                text = webViewCrashMessage ?: "WebGL renderer paused.",
                color = Color(0xFFD8E8F2),
                fontSize = 14.sp
              )
              Spacer(modifier = Modifier.height(18.dp))
              Button(
                onClick = {
                  webViewCrashMessage = null
                  renderCrashCount = 0
                  webViewKey += 1
                },
                modifier = Modifier.testTag("webview_retry_button"),
                colors = ButtonDefaults.buttonColors(
                  containerColor = Color(0xFF26E6C6),
                  contentColor = Color(0xFF041410)
                )
              ) {
                Text("Reload 3D World", fontWeight = FontWeight.Bold)
              }
            }
          }
        }
      }

      // 2. Native Floating Action Controls (Top Right, aligned with WebGL Quick Command Dock)
      Row(
        modifier = Modifier
          .align(Alignment.TopEnd)
          .padding(top = 44.dp, end = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp)
      ) {
        // Native Command Center Trigger
        Surface(
          onClick = {
            webViewHolder[0]?.evaluateJavascript(
              "if (typeof toggleEnvModal === 'function') { toggleEnvModal(); } else if (window.toggleEnvModal) { window.toggleEnvModal(); }",
              null
            )
          },
          modifier = Modifier
            .size(40.dp)
            .testTag("settings_button"),
          shape = CircleShape,
          color = Color(0xCC0A1016),
          shadowElevation = 8.dp,
          border = androidx.compose.foundation.BorderStroke(1.2.dp, Color(0x8826E6C6))
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = Icons.Default.Settings,
              contentDescription = "Command Center & Debug Menu",
              tint = Color(0xFF26E6C6),
              modifier = Modifier.size(20.dp)
            )
          }
        }

        // Native Field Guide Button
        Surface(
          onClick = { showGuideDialog = true },
          modifier = Modifier
            .size(40.dp)
            .testTag("survival_guide_button"),
          shape = CircleShape,
          color = Color(0xCC0A1016),
          shadowElevation = 8.dp,
          border = androidx.compose.foundation.BorderStroke(1.2.dp, Color(0x40FFFFFF))
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = Icons.Default.Info,
              contentDescription = "Wilderness Field Guide",
              tint = Color(0xFFF4FBF9),
              modifier = Modifier.size(20.dp)
            )
          }
        }
      }

      // 3. Survival Guide Modal Dialog
      if (showGuideDialog) {
        SurvivalGuideDialog(onDismiss = { showGuideDialog = false })
      }
    }
  }
}

@Composable
fun SurvivalGuideDialog(onDismiss: () -> Unit) {
  Dialog(onDismissRequest = onDismiss) {
    Card(
      modifier = Modifier
        .fillMaxWidth()
        .wrapContentHeight()
        .padding(12.dp)
        .testTag("survival_guide_dialog"),
      shape = RoundedCornerShape(24.dp),
      colors = CardDefaults.cardColors(
        containerColor = Color(0xF50A1016)
      ),
      border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x5526E6C6))
    ) {
      Column(
        modifier = Modifier
          .fillMaxWidth()
          .padding(20.dp)
          .verticalScroll(rememberScrollState())
      ) {
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically
        ) {
          Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
              imageVector = Icons.Default.Eco,
              contentDescription = null,
              tint = Color(0xFF26E6C6),
              modifier = Modifier.size(24.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
              text = "Castaway Field Guide",
              color = Color(0xFFF4FBF9),
              fontSize = 18.sp,
              fontWeight = FontWeight.Bold
            )
          }
          IconButton(
            onClick = onDismiss,
            modifier = Modifier
              .size(48.dp)
              .testTag("close_guide_button")
          ) {
            Icon(
              imageVector = Icons.Default.Close,
              contentDescription = "Close",
              tint = Color.White
            )
          }
        }

        Spacer(modifier = Modifier.height(14.dp))

        GuideSectionItem(
          icon = Icons.Default.Whatshot,
          title = "Campaign: 3 Avionics & Signal Rescue",
          description = "Recover all 3 Cockpit/Battery/Recorder Avionics across the wreck, deep reef, and caverns to repair the hilltop Radio Outpost, then launch a Signal Flare into the sky."
        )

        Spacer(modifier = Modifier.height(12.dp))

        GuideSectionItem(
          icon = Icons.Default.Water,
          title = "Lakes, Reef Diving & 1,000m+ Karst Caves",
          description = "Explore twin alpine lakes, underwater kelp trenches (tap Dive 🤿), the 470m Inter-Cave Karst Aqueduct, Lava Tube, and outer islands by raft or keeled boat."
        )

        Spacer(modifier = Modifier.height(12.dp))

        GuideSectionItem(
          icon = Icons.Default.Eco,
          title = "Tab-Organized Pack (🎒) & Settings (⚙️)",
          description = "Open 🎒 Pack on the Quick Belt for tabbed Gear, Craft, Build blueprints, and island Travel. Tap ⚙️ top-right for Weather, Graphics, Survey Map, and Debug Telemetry."
        )

        Spacer(modifier = Modifier.height(16.dp))

        Card(
          modifier = Modifier.fillMaxWidth(),
          shape = RoundedCornerShape(14.dp),
          colors = CardDefaults.cardColors(containerColor = Color(0x55000000))
        ) {
          Column(modifier = Modifier.padding(14.dp)) {
            Text(
              text = "🎯 Controls & Hold-Drag Ranged Aim",
              color = Color(0xFF26E6C6),
              fontWeight = FontWeight.Bold,
              fontSize = 14.sp
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
              text = "• Hold & Drag [Aim] (Bow / X-Bow / Pistol / Rifle / Flare): Slide thumb anywhere to fine-aim with zoom, release to fire, or drag onto [✕ Cancel] to abort safely.\n• Quick Tap [Chop / Thrust / Cast]: Harvest trees & rocks, strike nearby wildlife, or drink from streams.\n• Survivor Pod (Top-Left): Tap to expand Hunger, Thirst, Temp, Timber & Stone (auto-peeks on harvest or low vitals).\n• Quick Belt (Bottom): Swap Hatchet, Spear, Ranged, Utility & 🎒 Pack.",
              color = Color(0xFFB8CDC8),
              fontSize = 12.sp,
              lineHeight = 18.sp
            )
          }
        }

        Spacer(modifier = Modifier.height(20.dp))

        Button(
          onClick = onDismiss,
          modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .testTag("dismiss_guide_button"),
          shape = RoundedCornerShape(14.dp),
          colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF26E6C6))
        ) {
          Text(
            text = "Return to Wilderness",
            color = Color(0xFF041410),
            fontWeight = FontWeight.Bold,
            fontSize = 14.sp
          )
        }
      }
    }
  }
}

@Composable
fun GuideSectionItem(icon: ImageVector, title: String, description: String) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.Top
  ) {
    Box(
      modifier = Modifier
        .size(36.dp)
        .clip(RoundedCornerShape(10.dp))
        .background(Color(0x2826E6C6)),
      contentAlignment = Alignment.Center
    ) {
      Icon(
        imageVector = icon,
        contentDescription = null,
        tint = Color(0xFF26E6C6),
        modifier = Modifier.size(20.dp)
      )
    }
    Spacer(modifier = Modifier.width(12.dp))
    Column {
      Text(
        text = title,
        color = Color(0xFFF4FBF9),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold
      )
      Spacer(modifier = Modifier.height(2.dp))
      Text(
        text = description,
        color = Color(0xFF9AB4AE),
        fontSize = 12.sp,
        lineHeight = 16.sp
      )
    }
  }
}
