package com.example.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

private val DarkColorScheme = darkColorScheme(
  primary = ForestGreen80,
  secondary = LakeTeal80,
  tertiary = CampfireAmber80,
  background = WildernessDarkBackground,
  surface = WildernessDarkSurface,
  onPrimary = Color(0xFF052B0E),
  onSecondary = Color(0xFF003731),
  onBackground = WildernessTextPrimary,
  onSurface = WildernessTextPrimary
)

private val LightColorScheme = lightColorScheme(
  primary = ForestGreen40,
  secondary = LakeTeal40,
  tertiary = CampfireAmber40,
  background = Color(0xFFF1F8F2),
  surface = Color(0xFFE8F5E9),
  onPrimary = Color.White,
  onSecondary = Color.White,
  onBackground = Color(0xFF1B2E1D),
  onSurface = Color(0xFF1B2E1D)
)

@Composable
fun MyApplicationTheme(
  darkTheme: Boolean = isSystemInDarkTheme(),
  dynamicColor: Boolean = false, // Keep immersive nature color scheme
  content: @Composable () -> Unit,
) {
  val colorScheme =
    when {
      dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
        val context = LocalContext.current
        if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
      }
      darkTheme -> DarkColorScheme
      else -> DarkColorScheme // Wilderness theme defaults to immersive dark
    }

  MaterialTheme(colorScheme = colorScheme, typography = Typography, content = content)
}
