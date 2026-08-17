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

    private lateinit var webView: WebView
    private var pageLoaded = false
    private val pendingJs = mutableListOf<String>()
    private var pendingUri: Pair<Uri, String>? = null
    private lateinit var folderPicker: ActivityResultLauncher<Uri?>
    private lateinit var filePicker: ActivityResultLauncher<Array<String>>

    companion object {
        private const val TAG = "CodeX"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            setupPickers()
            webView = WebView(this)
            setContentView(webView)
            setupWebView()
            webView.loadUrl("file:///android_asset/www/index.html")
            handleIntent(intent)
            Log.d(TAG, "onCreate complete")
        } catch (e: Throwable) {
            Log.e(TAG, "onCreate crashed", e)
            showError(e)
        }
    }

    // ------------------------------------------------------------------
    //  SAF 选择器注册（必须在 onStart 之前调用）
    // ------------------------------------------------------------------

    private fun setupPickers() {
        folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
            Log.d(TAG, "folderPicker result: uri=$uri")
            if (uri != null) {
                grantUriPermission(uri)
                val name = queryDisplayName(uri) ?: "项目"
                Log.d(TAG, "folder picked: name=$name, uri=$uri")
                val qUri = JSONObject.quote(uri.toString())
                val qName = JSONObject.quote(name)
                eval("window.__codexFolderCb($qUri, $qName)")
            } else {
                Log.d(TAG, "folder picker canceled")
                eval("window.__codexFolderCb(null, null)")
            }
        }
        filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            Log.d(TAG, "filePicker result: uri=$uri")
            if (uri != null) {
                grantUriPermission(uri)
                val name = queryDisplayName(uri) ?: (uri.lastPathSegment ?: "file")
                Log.d(TAG, "file picked: name=$name, uri=$uri")
                val qUri = JSONObject.quote(uri.toString())
                val qName = JSONObject.quote(name)
                eval("window.__codexFileCb($qUri, $qName)")
            } else {
                eval("window.__codexFileCb(null, null)")
            }
        }
    }

    // ------------------------------------------------------------------
    //  错误对话框
    // ------------------------------------------------------------------

    private fun showError(e: Throwable) {
        val trace = e.stackTrace?.take(12)?.joinToString("\n") { it.toString() } ?: ""
        AlertDialog.Builder(this)
            .setTitle("CodeX 启动出错")
            .setMessage("${e.javaClass.simpleName}: ${e.message}\n\n$trace")
            .setPositiveButton("退出") { _, _ -> finish() }
            .setCancelable(false)
            .show()
    }

    // ------------------------------------------------------------------
    //  Intent 处理（外部文件关联打开）
    // ------------------------------------------------------------------

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val uri: Uri? = when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(Intent.EXTRA_STREAM)
            }
            else -> null
        }
        if (uri == null) return
        val name = queryDisplayName(uri) ?: (uri.lastPathSegment ?: "file")
        if (pageLoaded) openExternal(uri, name)
        else pendingUri = Pair(uri, name)
    }

    // ------------------------------------------------------------------
    //  WebView 配置
    // ------------------------------------------------------------------

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
                Log.d(TAG, "page loaded: $url")
                // 执行积压的 JS 调用
                synchronized(pendingJs) {
                    pendingJs.forEach { webView.evaluateJavascript(it, null) }
                    pendingJs.clear()
                }
                // 执行积压的外部文件打开
                pendingUri?.let {
                    openExternal(it.first, it.second)
                    pendingUri = null
                }
            }
        }
        webView.addJavascriptInterface(FileBridge(this), "AndroidBridge")
    }

    // ------------------------------------------------------------------
    //  公开方法（供 FileBridge 调用）
    // ------------------------------------------------------------------

    fun launchFolderPicker() {
        Log.d(TAG, "launching folder picker")
        try {
            folderPicker.launch(null)
        } catch (e: Exception) {
            Log.e(TAG, "folderPicker.launch failed", e)
        }
    }

    fun launchFilePicker() {
        Log.d(TAG, "launching file picker")
        try {
            filePicker.launch(arrayOf("*/*"))
        } catch (e: Exception) {
            Log.e(TAG, "filePicker.launch failed", e)
        }
    }

    // ------------------------------------------------------------------
    //  JS 执行（支持页面未加载时排队）
    // ------------------------------------------------------------------

    fun eval(js: String) {
        if (pageLoaded) {
            webView.evaluateJavascript(js, null)
        } else {
            synchronized(pendingJs) { pendingJs.add(js) }
        }
    }

    // ------------------------------------------------------------------
    //  内部方法
    // ------------------------------------------------------------------

    private fun grantUriPermission(uri: Uri) {
        try {
            contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            Log.d(TAG, "persisted permission for $uri")
        } catch (e: Exception) {
            Log.w(TAG, "persist permission failed: ${e.message}")
        }
    }

    private fun queryDisplayName(uri: Uri): String? {
        return try {
            val segments = uri.pathSegments ?: emptyList()
            val isTree = segments.contains("tree")
            val docId = if (isTree) DocumentsContract.getTreeDocumentId(uri)
                        else DocumentsContract.getDocumentId(uri)
            val docUri = DocumentsContract.buildDocumentUriUsingTree(uri, docId)
            contentResolver.query(
                docUri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null, null, null
            )?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        } catch (e: Exception) {
            Log.w(TAG, "queryDisplayName failed: ${e.message}")
            null
        }
    }

    private fun openExternal(uri: Uri, name: String) {
        val qUri = JSONObject.quote(uri.toString())
        val qName = JSONObject.quote(name)
        eval("App.openExternal($qUri, $qName)")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
