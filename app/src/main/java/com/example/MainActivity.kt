package com.example

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
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

class WebAppInterface(private val context: Context) {
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
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WildernessSurvivalApp() {
  val context = LocalContext.current
  var showGuideDialog by remember { mutableStateOf(false) }
  var webViewRef by remember { mutableStateOf<WebView?>(null) }

  BackHandler(enabled = showGuideDialog) {
    showGuideDialog = false
  }

  Scaffold(
    modifier = Modifier
      .fillMaxSize()
      .testTag("wilderness_scaffold"),
    containerColor = Color.Black
  ) { _ ->
    Box(
      modifier = Modifier
        .fillMaxSize()
        .testTag("wilderness_container")
    ) {
      // 1. Hardware-Accelerated 3D WebGL Viewport
      AndroidView(
        factory = { ctx ->
          WebView(ctx).apply {
            webViewRef = this
            layoutParams = ViewGroup.LayoutParams(
              ViewGroup.LayoutParams.MATCH_PARENT,
              ViewGroup.LayoutParams.MATCH_PARENT
            )
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            setBackgroundColor(android.graphics.Color.BLACK)

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
                Log.d("SylvanWeb", "Wilderness page loaded: $url")
              }
            }

            addJavascriptInterface(WebAppInterface(ctx), "AndroidBridge")
            loadUrl("file:///android_asset/wilderness/index.html")
          }
        },
        modifier = Modifier
          .fillMaxSize()
          .testTag("wilderness_webview")
      )

      // 2. Native Floating Action Controls (Top Right, safely below notch/status bar)
      Row(
        modifier = Modifier
          .align(Alignment.TopEnd)
          .padding(top = 52.dp, end = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp)
      ) {
        // Native Settings & Environment Trigger
        Surface(
          onClick = {
            webViewRef?.evaluateJavascript(
              "if (typeof toggleEnvModal === 'function') { toggleEnvModal(); } else if (window.toggleEnvModal) { window.toggleEnvModal(); }",
              null
            )
          },
          modifier = Modifier
            .size(46.dp)
            .testTag("settings_button"),
          shape = CircleShape,
          color = Color(0xD90E2419),
          shadowElevation = 8.dp,
          border = androidx.compose.foundation.BorderStroke(1.5.dp, Color(0xFF26A69A))
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = Icons.Default.Settings,
              contentDescription = "Environment & Graphics Settings",
              tint = Color(0xFF80CBC4),
              modifier = Modifier.size(24.dp)
            )
          }
        }

        // Native Field Guide Button
        Surface(
          onClick = { showGuideDialog = true },
          modifier = Modifier
            .size(46.dp)
            .testTag("survival_guide_button"),
          shape = CircleShape,
          color = Color(0xD90E2419),
          shadowElevation = 8.dp,
          border = androidx.compose.foundation.BorderStroke(1.5.dp, Color(0x66FFFFFF))
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = Icons.Default.Info,
              contentDescription = "Wilderness Field Guide",
              tint = Color(0xFFE0F2F1),
              modifier = Modifier.size(24.dp)
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
        containerColor = Color(0xF20B1A12)
      ),
      border = androidx.compose.foundation.BorderStroke(1.dp, Color(0x3326A69A))
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
              tint = Color(0xFF80CBC4),
              modifier = Modifier.size(24.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
              text = "Sylvan Survival Guide",
              color = Color(0xFFE0F2F1),
              fontSize = 18.sp,
              fontWeight = FontWeight.Bold
            )
          }
          IconButton(
            onClick = onDismiss,
            modifier = Modifier
              .size(36.dp)
              .testTag("close_guide_button")
          ) {
            Icon(
              imageVector = Icons.Default.Close,
              contentDescription = "Close",
              tint = Color.White
            )
          }
        }

        Spacer(modifier = Modifier.height(16.dp))

        GuideSectionItem(
          icon = Icons.Default.Water,
          title = "Multi-Tier Hydrology & Currents",
          description = "A mountain stream cascades down rocky valley rapids into Pine Lake and a forest pond. Stream currents push swimmers and floating logs downstream."
        )

        Spacer(modifier = Modifier.height(12.dp))

        GuideSectionItem(
          icon = Icons.Default.Eco,
          title = "Lifelike Wilderness Ecosystem",
          description = "Spruce conifers, white birches, granite boulders, ferns, and river pebbles populate the valley with atmospheric lighting and dynamic shadows."
        )

        Spacer(modifier = Modifier.height(12.dp))

        GuideSectionItem(
          icon = Icons.Default.Whatshot,
          title = "Physical Wave Buoyancy",
          description = "Logs tossed into water bob realistically on wave crests and drift downstream. Campfires provide life-saving warmth against nocturnal hypothermia."
        )

        Spacer(modifier = Modifier.height(16.dp))

        Card(
          modifier = Modifier.fillMaxWidth(),
          shape = RoundedCornerShape(14.dp),
          colors = CardDefaults.cardColors(containerColor = Color(0x40000000))
        ) {
          Column(modifier = Modifier.padding(14.dp)) {
            Text(
              text = "🕹️ Touch Controls",
              color = Color(0xFF80CBC4),
              fontWeight = FontWeight.Bold,
              fontSize = 14.sp
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
              text = "• Left Thumb: Virtual Joystick for walking & wading\n• Right Thumb: Drag anywhere to look around\n• Strike [🪓]: Chop trees for timber or drink clean water\n• Float Log [🪵]: Toss buoyant timber into the river\n• Campfire [🔥]: Toggle warm glowing fire pit\n• Settings [⚙️]: Time-of-day, weather & wave controls",
              color = Color(0xFFB0BEC5),
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
          colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF26A69A))
        ) {
          Text(
            text = "Return to Wilderness",
            color = Color(0xFF041913),
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
        .background(Color(0x3326A69A)),
      contentAlignment = Alignment.Center
    ) {
      Icon(
        imageVector = icon,
        contentDescription = null,
        tint = Color(0xFF80CBC4),
        modifier = Modifier.size(20.dp)
      )
    }
    Spacer(modifier = Modifier.width(12.dp))
    Column {
      Text(
        text = title,
        color = Color(0xFFECEFF1),
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold
      )
      Spacer(modifier = Modifier.height(2.dp))
      Text(
        text = description,
        color = Color(0xFF90A4AE),
        fontSize = 12.sp,
        lineHeight = 16.sp
      )
    }
  }
}
