package com.codex.app

import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通过 addJavascriptInterface 暴露给 Web 层 (window.AndroidBridge)。
 * 文件访问基于 Storage Access Framework (SAF)，可在安卓上读写手机任意目录。
 */
class FileBridge(private val activity: MainActivity) {

    @android.webkit.JavascriptInterface
    fun pickFolder() {
        activity.launchFolderPicker()
    }

    @android.webkit.JavascriptInterface
    fun pickFile() {
        activity.launchFilePicker()
    }

    @android.webkit.JavascriptInterface
    fun listChildren(uriStr: String): String {
        return try {
            val uri = Uri.parse(uriStr)
            val treeId = DocumentsContract.getTreeDocumentId(uri)
            val treeUri = DocumentsContract.buildDocumentUriUsingTree(uri, treeId)
            val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
                treeUri, DocumentsContract.getDocumentId(uri)
            )
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
                    val obj = JSONObject()
                    obj.put("name", name)
                    obj.put("type", type)
                    obj.put("uri", childUri.toString())
                    result.put(obj)
                }
            }
            result.toString()
        } catch (e: Exception) {
            Log.e("CodeX", "listChildren failed: ${e.message}", e)
            "[]"
        }
    }

    @android.webkit.JavascriptInterface
    fun readFile(uriStr: String): String {
        return try {
            val uri = Uri.parse(uriStr)
            activity.contentResolver.openInputStream(uri)?.use { input ->
                val size = input.available()
                if (size > 4 * 1024 * 1024) return "__CODEX_ERR__文件过大（>4MB），无法显示"
                input.bufferedReader(Charsets.UTF_8).readText()
            } ?: "__CODEX_ERR__无法读取文件（Uri 为空）"
        } catch (e: Exception) {
            "__CODEX_ERR__" + (e.message ?: "read failed")
        }
    }

    @android.webkit.JavascriptInterface
    fun writeFile(uriStr: String, content: String): Boolean {
        return try {
            val uri = Uri.parse(uriStr)
            activity.contentResolver.openOutputStream(uri, "wt")?.use { out ->
                out.write(content.toByteArray(Charsets.UTF_8))
            }
            true
        } catch (e: Exception) {
            Log.e("CodeX", "writeFile failed: ${e.message}", e)
            false
        }
    }
}
