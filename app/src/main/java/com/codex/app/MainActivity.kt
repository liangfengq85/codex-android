package com.codex.app

import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    lateinit var webView: WebView
    private var pageLoaded = false
    private var pendingUri: Pair<Uri, String>? = null
    private lateinit var folderPicker: ActivityResultLauncher<Uri?>
    private lateinit var filePicker: ActivityResultLauncher<Array<String>>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            setupPickers()
            webView = WebView(this)
            setContentView(webView)
            setupWebView()
            webView.loadUrl("file:///android_asset/www/index.html")
            handleIntent(intent)
        } catch (e: Throwable) {
            Log.e("CodeX", "onCreate crashed", e)
            showError(e)
        }
    }

    private fun setupPickers() {
        folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            if (uri != null) {
                grantUriPermission(uri)
                val name = displayName(uri) ?: "项目"
                val json = JSONObject().put("uri", uri.toString()).put("name", name).toString()
                eval("CodeXNative.onPickFolder(${JSONObject.quote(json)})")
            } else {
                eval("CodeXNative.onPickFolder(null)")
            }
        }
        filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) {
                grantUriPermission(uri)
                val name = displayName(uri) ?: (uri.lastPathSegment ?: "file")
                val json = JSONObject().put("uri", uri.toString()).put("name", name).toString()
                eval("CodeXNative.onPickFile(${JSONObject.quote(json)})")
            } else {
                eval("CodeXNative.onPickFile(null)")
            }
        }
    }

    private fun showError(e: Throwable) {
        val trace = e.stackTrace?.take(12)?.joinToString("\n") { it.toString() } ?: ""
        AlertDialog.Builder(this)
            .setTitle("CodeX 启动出错")
            .setMessage("${e.javaClass.simpleName}: ${e.message}\n\n$trace")
            .setPositiveButton("退出") { _, _ -> finish() }
            .setCancelable(false)
            .show()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            builtInZoomControls = true
            displayZoomControls = false
            setSupportZoom(true)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                pageLoaded = true
                pendingUri?.let {
                    openExternal(it.first, it.second)
                    pendingUri = null
                }
            }
        }
        webView.addJavascriptInterface(FileBridge(this), "AndroidBridge")
    }

    fun launchFolderPicker() = folderPicker.launch(null)
    fun launchFilePicker() = filePicker.launch(arrayOf("*/*"))

    private fun grantUriPermission(uri: Uri) {
        try {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (e: Exception) {
            // 某些 Uri 不支持持久化权限，忽略
        }
    }

    private fun displayName(uri: Uri): String? {
        return try {
            val hasTree = uri.pathSegments.contains("tree")
            val hasDocument = uri.pathSegments.contains("document")
            val docUri = if (hasTree) {
                val docId = if (hasDocument) DocumentsContract.getDocumentId(uri)
                else DocumentsContract.getTreeDocumentId(uri)
                DocumentsContract.buildDocumentUriUsingTree(uri, docId)
            } else {
                uri
            }
            contentResolver.query(
                docUri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null, null, null
            )?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val uri: Uri? = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> intent.getParcelableExtra(Intent.EXTRA_STREAM)
            else -> null
        }
        if (uri == null) return
        val name = displayName(uri) ?: (uri.lastPathSegment ?: "file")
        if (pageLoaded) openExternal(uri, name)
        else pendingUri = Pair(uri, name)
    }

    private fun openExternal(uri: Uri, name: String) {
        eval("App.openExternal(${JSONObject.quote(uri.toString())}, ${JSONObject.quote(name)})")
    }

    private fun eval(js: String) {
        if (pageLoaded) webView.evaluateJavascript(js, null)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
