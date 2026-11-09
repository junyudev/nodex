package app.nodex.tls

import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import okhttp3.*
import okhttp3.RequestBody.Companion.toRequestBody
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.net.Proxy
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

private const val BODY_LIMIT = 8 * 1024 * 1024
private const val FRAME_LIMIT = 1024 * 1024
class TlsOptions : Record {
  @Field var url: String = ""
  @Field var fingerprint: String = ""
  @Field var headers: Map<String, String> = emptyMap()
  @Field var timeoutMs: Int = 15000
  @Field var method: String = "GET"
  @Field var body: String = ""
}
private class PinMismatch : CertificateException("Leaf certificate does not match pin")

// TLS invokes this before OkHttp can write HTTP headers, bodies, or upgrade bytes.
private class LeafTrust(private val fingerprint: String) : X509TrustManager {
  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
    val actual = chain.firstOrNull()?.encoded?.let { MessageDigest.getInstance("SHA-256").digest(it) }
    val expected = fingerprint.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    if (actual == null || !MessageDigest.isEqual(actual, expected)) throw PinMismatch()
  }
  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
    throw CertificateException("Client trust is not supported")
  }
  override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

class PinnedTlsModule : Module() {
  private inner class Operation(val id: String, val client: OkHttpClient) {
    var call: Call? = null
    var socket: WebSocket? = null
    private var done = false
    @Synchronized fun event(value: Map<String, Any>) {
      if (!done) sendEvent("event", value + ("id" to id))
    }
    @Synchronized fun finish(value: Map<String, Any>? = null) {
      if (done) return
      value?.let { event(it) }
      done = true
      call?.cancel()
      socket?.cancel()
      client.connectionPool.evictAll()
      client.dispatcher.executorService.shutdown()
      operations.remove(id, this)
    }
  }
  private val operations = ConcurrentHashMap<String, Operation>()
  override fun definition() = ModuleDefinition {
    Name("NodexPinnedTls")
    Events("event")
    Function("startRequest") { id: String, options: TlsOptions -> start(id, options, false) }
    Function("openSocket") { id: String, options: TlsOptions -> start(id, options, true) }
    Function("cancel") { id: String -> operations[id]?.finish() }
    Function("send") { id: String, body: String, binary: Boolean ->
      val op = operations[id] ?: return@Function
      val bytes = if (binary) Base64.decode(body, Base64.NO_WRAP) else body.toByteArray(Charsets.UTF_8)
      if (bytes.size > FRAME_LIMIT) {
        op.finish(mapOf("type" to "error", "code" to "limit")); return@Function
      }
      val socket = op.socket ?: return@Function
      // Bound outgoing buffered bytes as well as each individual message.
      if (socket.queueSize() + bytes.size > BODY_LIMIT) {
        op.finish(mapOf("type" to "error", "code" to "limit")); return@Function
      }
      val accepted = if (binary) socket.send(bytes.toByteString()) else socket.send(body)
      if (!accepted) op.finish(mapOf("type" to "error", "code" to "closed"))
    }
    OnDestroy { operations.values.toList().forEach { it.finish() } }
  }

  private fun failure(error: Throwable): String {
    if (generateSequence(error) { it.cause }.any { it is PinMismatch }) return "pin"
    if (error is SocketTimeoutException || error is java.io.InterruptedIOException) return "timeout"
    return "transport"
  }

  @Synchronized private fun start(id: String, options: TlsOptions, socket: Boolean) {
    if (operations.size >= 32 || operations.containsKey(id)) {
      sendEvent("event", mapOf("id" to id, "type" to "error", "code" to "limit")); return
    }
    val scheme = if (socket) "wss" else "https"
    val uri = try { java.net.URI(options.url) } catch (_: Exception) { null }
    if (uri == null || uri.scheme != scheme || uri.host == null || uri.userInfo != null ||
      uri.fragment != null || !options.fingerprint.matches(Regex("[a-fA-F0-9]{64}")) || options.timeoutMs !in 1..60000) {
      sendEvent("event", mapOf("id" to id, "type" to "error", "code" to "invalid")); return
    }
    try {
      val body = Base64.decode(options.body, Base64.NO_WRAP)
      require(body.size <= BODY_LIMIT)
      val trust = LeafTrust(options.fingerprint.lowercase())
      // A fresh SSLContext prevents session resumption from bypassing a new pin decision.
      val context = SSLContext.getInstance("TLS")
      context.init(null, arrayOf(trust), null)
      val client = OkHttpClient.Builder()
        .sslSocketFactory(context.socketFactory, trust)
        // The DER pin is the authority; this exception is local to this client only.
        .hostnameVerifier { _, _ -> true }
        .connectionSpecs(listOf(ConnectionSpec.Builder(ConnectionSpec.MODERN_TLS)
          .tlsVersions(TlsVersion.TLS_1_3, TlsVersion.TLS_1_2).build()))
        .protocols(listOf(Protocol.HTTP_1_1))
        .proxy(Proxy.NO_PROXY)
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(options.timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        .readTimeout(if (socket) 0 else options.timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        // Effect owns the upgrade deadline; an open stream has no whole-call deadline.
        .callTimeout(if (socket) 0 else options.timeoutMs.toLong(), TimeUnit.MILLISECONDS)
        .build()
      val op = Operation(id, client)
      operations[id] = op
      val builder = Request.Builder().url(options.url)
      options.headers.forEach { (key, value) -> builder.header(key, value) }
      if (socket) {
        op.socket = client.newWebSocket(builder.build(), object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) { op.event(mapOf("type" to "open")) }
          override fun onMessage(webSocket: WebSocket, text: String) {
            if (text.toByteArray(Charsets.UTF_8).size > FRAME_LIMIT) {
              op.finish(mapOf("type" to "error", "code" to "limit")); return
            }
            op.event(mapOf("type" to "message", "text" to text))
          }
          override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (bytes.size > FRAME_LIMIT) {
              op.finish(mapOf("type" to "error", "code" to "limit")); return
            }
            op.event(mapOf("type" to "message", "body" to bytes.base64()))
          }
          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            op.finish(mapOf("type" to "close", "code" to code))
          }
          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            response?.close()
            op.finish(mapOf("type" to "error", "code" to failure(t)))
          }
        })
        return
      }
      val payload = if (options.method == "GET" || options.method == "HEAD") null else body.toRequestBody()
      val call = client.newCall(builder.method(options.method, payload).build())
      op.call = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) { op.finish(mapOf("type" to "error", "code" to failure(e))) }
        override fun onResponse(call: Call, response: Response) {
          response.use {
            try {
              val source = response.body?.source()
              val buffer = okio.Buffer()
              while (buffer.size <= BODY_LIMIT && source != null) {
                if (source.read(buffer, minOf(8192L, BODY_LIMIT + 1L - buffer.size)) == -1L) break
              }
              val bytes = buffer.readByteArray()
              if (bytes.size > BODY_LIMIT) { op.finish(mapOf("type" to "error", "code" to "limit")); return }
              op.finish(mapOf("type" to "response", "status" to response.code,
                "headers" to response.headers.names().associateWith { response.header(it).orEmpty() },
                "body" to Base64.encodeToString(bytes, Base64.NO_WRAP)))
            } catch (error: Exception) { op.finish(mapOf("type" to "error", "code" to failure(error))) }
          }
        }
      })
    } catch (_: Exception) {
      operations[id]?.finish()
      sendEvent("event", mapOf("id" to id, "type" to "error", "code" to "invalid"))
    }
  }
}
