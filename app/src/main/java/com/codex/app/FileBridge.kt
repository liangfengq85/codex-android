package com.codex.app

import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通过 addJavascriptInterface 暴露给 Web 层 (window.AndroidBridge)。
 * 文件访问基于 Storage Access Framework (SAF)，可读写手机任意目录。
 *
 * 关键方法：
 *   testBridge()         — 诊断用，返回 "OK"
 *   pickFolder()         — 启动系统文件夹选择器
 *   pickFile()            — 启动系统文件选择器
 *   buildTree(uri)       — 一次性返回完整目录树 JSON（比递归 listChildren 快 10 倍+）
 *   listAllFiles(uri)    — 返回所有文件的扁平列表（用于全局搜索）
 *   listChildren(uri)    — 列出单个目录的子项（兼容保留）
 *   readFile(uri)        — 读取文件文本内容
 *   writeFile(uri,text)  — 写入文件
 */
class FileBridge(private val activity: MainActivity) {

    companion object {
        private const val TAG = "CodeX"
        private const val MAX_DEPTH = 12
        private const val MAX_FILES = 8000
        private val SKIP_DIRS = setOf(
            "node_modules", ".git", ".idea", ".vscode", "dist", "build",
            "__pycache__", ".next", "vendor", ".gradle", "target", "bin", "obj",
            ".turbo", ".cxx", "Release", "Debug", ".externalNativeBuild"
        )
    }

    // ------------------------------------------------------------------
    //  诊断
    // ------------------------------------------------------------------

    @JavascriptInterface
    fun testBridge(): String {
        Log.d(TAG, "testBridge() called — OK")
        return "OK"
    }

    // ------------------------------------------------------------------
    //  选择器
    // ------------------------------------------------------------------

    @JavascriptInterface
    fun pickFolder() {
        Log.d(TAG, "pickFolder() called from JS")
        activity.runOnUiThread { activity.launchFolderPicker() }
    }

    @JavascriptInterface
    fun pickFile() {
        Log.d(TAG, "pickFile() called from JS")
        activity.runOnUiThread { activity.launchFilePicker() }
    }

    // ------------------------------------------------------------------
    //  构建完整目录树（一次 IPC 返回，避免递归往返）
    // ------------------------------------------------------------------

    @JavascriptInterface
    fun buildTree(uriStr: String): String {
        Log.d(TAG, "buildTree: $uriStr")
        return try {
            val uri = Uri.parse(uriStr)
            val segments = uri.pathSegments ?: emptyList()
            val isTree = segments.contains("tree")
            val treeUri = uri
            val rootDocId = if (isTree) DocumentsContract.getTreeDocumentId(uri)
                            else DocumentsContract.getDocumentId(uri)
            val rootName = queryDisplayName(treeUri, rootDocId) ?: "项目"
            val counter = intArrayOf(0)
            val root = buildNode(treeUri, rootDocId, rootName, 0, counter)
            Log.d(TAG, "buildTree done: ${counter[0]} files")
            root.toString()
        } catch (e: Exception) {
            Log.e(TAG, "buildTree failed: ${e.message}", e)
            JSONObject().put("error", "buildTree: ${e.message}").toString()
        }
    }

    // ------------------------------------------------------------------
    //  列出所有文件（扁平数组，供全局搜索用）
    // ------------------------------------------------------------------

    @JavascriptInterface
    fun listAllFiles(uriStr: String): String {
        Log.d(TAG, "listAllFiles: $uriStr")
        return try {
            val uri = Uri.parse(uriStr)
            val segments = uri.pathSegments ?: emptyList()
            val isTree = segments.contains("tree")
            val treeUri = uri
            val rootDocId = if (isTree) DocumentsContract.getTreeDocumentId(uri)
                            else DocumentsContract.getDocumentId(uri)
            val rootName = queryDisplayName(treeUri, rootDocId) ?: "项目"
            val result = JSONArray()
            val counter = intArrayOf(0)
            collectFiles(result, treeUri, rootDocId, rootName, 0, counter)
            Log.d(TAG, "listAllFiles done: ${counter[0]} files")
            result.toString()
        } catch (e: Exception) {
            Log.e(TAG, "listAllFiles failed: ${e.message}", e)
            JSONArray().toString()
        }
    }

    // ------------------------------------------------------------------
    //  列出单个目录的子项（兼容保留，用于懒加载）
    // ------------------------------------------------------------------

    @JavascriptInterface
    fun listChildren(uriStr: String): String {
        Log.d(TAG, "listChildren: $uriStr")
        return try {
            val uri = Uri.parse(uriStr)
            val segments = uri.pathSegments ?: emptyList()
            val hasDocument = segments.contains("document")
            val isTree = segments.contains("tree")
            val treeUri = uri
            val docId = when {
                hasDocument -> DocumentsContract.getDocumentId(uri)
                isTree -> DocumentsContract.getTreeDocumentId(uri)
                else -> DocumentsContract.getDocumentId(uri)
            }
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
            Log.d(TAG, "childrenUri: $childrenUri")
            val result = JSONArray()
            activity.contentResolver.query(
                childrenUri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE
                ),
                null, null, null
            )?.use { c ->
                val idIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                while (c.moveToNext()) {
                    val id = c.getString(idIdx)
                    val name = c.getString(nameIdx)
                    val mime = c.getString(mimeIdx)
                    val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, id)
                    val type = if (mime == DocumentsContract.Document.MIME_TYPE_DIR) "dir" else "file"
                    result.put(JSONObject()
                        .put("name", name)
                        .put("type", type)
                        .put("uri", childUri.toString())
                    )
                }
            }
            Log.d(TAG, "listChildren: ${result.length()} items")
            result.toString()
        } catch (e: Exception) {
            Log.e(TAG, "listChildren failed: ${e.message}", e)
            JSONObject().put("error", "listChildren: ${e.message}").toString()
        }
    }

    // ------------------------------------------------------------------
    //  读 / 写文件
    // ------------------------------------------------------------------

    @JavascriptInterface
    fun readFile(uriStr: String): String {
        Log.d(TAG, "readFile: $uriStr")
        return try {
            val uri = Uri.parse(uriStr)
            activity.contentResolver.openInputStream(uri)?.use { input ->
                val avail = input.available()
                if (avail > 4 * 1024 * 1024) {
                    return "__CODEX_ERR__文件过大(>${avail / 1024}KB)"
                }
                input.bufferedReader(Charsets.UTF_8).readText()
            } ?: "__CODEX_ERR__无法打开文件流"
        } catch (e: Exception) {
            Log.e(TAG, "readFile failed: ${e.message}", e)
            "__CODEX_ERR__${e.message ?: "read failed"}"
        }
    }

    @JavascriptInterface
    fun writeFile(uriStr: String, content: String): Boolean {
        Log.d(TAG, "writeFile: $uriStr, len=${content.length}")
        return try {
            val uri = Uri.parse(uriStr)
            activity.contentResolver.openOutputStream(uri, "wt")?.use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
                true
            } ?: false
        } catch (e: Exception) {
            Log.e(TAG, "writeFile failed: ${e.message}", e)
            false
        }
    }

    @JavascriptInterface
    fun getDisplayName(uriStr: String): String {
        return try {
            val uri = Uri.parse(uriStr)
            val segments = uri.pathSegments ?: emptyList()
            val isTree = segments.contains("tree")
            val docId = if (isTree) DocumentsContract.getTreeDocumentId(uri)
                        else DocumentsContract.getDocumentId(uri)
            queryDisplayName(uri, docId) ?: ""
        } catch (e: Exception) {
            ""
        }
    }

    // ==================================================================
    //  内部方法
    // ==================================================================

    private fun queryDisplayName(treeUri: Uri, docId: String): String? {
        return try {
            val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)
            activity.contentResolver.query(
                docUri,
                arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),
                null, null, null
            )?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        } catch (e: Exception) {
            Log.w(TAG, "queryDisplayName failed: ${e.message}")
            null
        }
    }

    /**
     * 递归构建目录树节点。
     * treeUri 始终是根 tree URI（buildChildDocumentsUriUsingTree 从中提取 treeId）。
     */
    private fun buildNode(
        treeUri: Uri, docId: String, name: String, depth: Int, counter: IntArray
    ): JSONObject {
        val obj = JSONObject()
        obj.put("name", name)
        obj.put("type", "dir")
        obj.put("uri", DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString())

        if (depth >= MAX_DEPTH || counter[0] >= MAX_FILES) {
            obj.put("children", JSONArray())
            return obj
        }

        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
        val children = JSONArray()
        val items = mutableListOf<Triple<String, String, String>>() // id, name, mime

        try {
            activity.contentResolver.query(
                childrenUri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE
                ),
                null, null, null
            )?.use { c ->
                val idIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                while (c.moveToNext()) {
                    items.add(Triple(
                        c.getString(idIdx) ?: "",
                        c.getString(nameIdx) ?: "",
                        c.getString(mimeIdx) ?: ""
                    ))
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "buildNode query failed at depth $depth: ${e.message}")
        }

        // 排序：目录在前，然后按名称不区分大小写
        items.sortWith { a, b ->
            val dirA = if (a.third == DocumentsContract.Document.MIME_TYPE_DIR) 0 else 1
            val dirB = if (b.third == DocumentsContract.Document.MIME_TYPE_DIR) 0 else 1
            if (dirA != dirB) dirA - dirB
            else a.second.compareTo(b.second, ignoreCase = true)
        }

        for (item in items) {
            val (id, childName, mime) = item
            if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                if (SKIP_DIRS.contains(childName)) continue
                if (counter[0] >= MAX_FILES) break
                children.put(buildNode(treeUri, id, childName, depth + 1, counter))
            } else {
                counter[0]++
                children.put(JSONObject()
                    .put("name", childName)
                    .put("type", "file")
                    .put("uri", DocumentsContract.buildDocumentUriUsingTree(treeUri, id).toString())
                )
            }
        }

        obj.put("children", children)
        return obj
    }

    /**
     * 递归收集所有文件到扁平数组（供全局搜索用）。
     */
    private fun collectFiles(
        result: JSONArray, treeUri: Uri, docId: String,
        path: String, depth: Int, counter: IntArray
    ) {
        if (depth >= MAX_DEPTH || counter[0] >= MAX_FILES) return

        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, docId)
        try {
            activity.contentResolver.query(
                childrenUri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE
                ),
                null, null, null
            )?.use { c ->
                val idIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
                val nameIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
                val mimeIdx = c.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)
                while (c.moveToNext()) {
                    val id = c.getString(idIdx)
                    val name = c.getString(nameIdx)
                    val mime = c.getString(mimeIdx)
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (SKIP_DIRS.contains(name)) continue
                        collectFiles(result, treeUri, id, "$path/$name", depth + 1, counter)
                    } else {
                        counter[0]++
                        result.put(JSONObject()
                            .put("path", "$path/$name")
                            .put("name", name)
                            .put("uri", DocumentsContract.buildDocumentUriUsingTree(treeUri, id).toString())
                        )
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "collectFiles failed at depth $depth: ${e.message}")
        }
    }
}
