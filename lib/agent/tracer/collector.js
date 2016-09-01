'use strict'

var debug = require('debug')('risingstack/trace:agent:tracer:collector')
var microtime = require('../../optionalDependencies/microtime')
var ExpiringBuffer = require('./expiringBuffer')
var uuid = require('uuid')
var assign = require('lodash.assign')
var levels = require('./severity')

var EVENT_TYPE = {
  CLIENT_SEND: 'cs',
  SERVER_SEND: 'ss',
  CLIENT_RECV: 'cr',
  SERVER_RECV: 'sr',
  ERROR: 'err',
  USER_SENT: 'us'
}

var ERROR_TYPE = {
  USER_SENT: 'user-sent-error',
  NETWORK: 'network-error',
  SYSTEM: 'system-error'
}

function transformError (error, noStack) {
  return assign({
    name: error.name,
    message: error.message,
    stack: noStack ? undefined : error.stack,
    lineNumber: error.lineNumber,
    fileName: error.fileName,
    columnNumber: error.columnNumber
  }, error)
}

function Collector (options) {
  this.serviceKey = options.serviceKey
  this.mustCollectSeverity = levels.ERROR
  this.defaultSeverity = levels.INFO

  // init required variables
  this._noStack = options.noStack
  this._eventTtl = options.eventTtl || 1
  this._eventBuffers = { }
  this._mustCollectBuffer = []
}

Collector.prototype.LEVELS = levels

Collector.prototype.CACHE_MODES = {
  NORMAL: 0,
  RETAIN_UNTIL_SS: 1
}

Collector.prototype.userSentEvent = function (briefcase, name, payload) {
  briefcase = briefcase || {}
  var communicationId = briefcase.communication && briefcase.communication.id
  var transactionId = briefcase.communication && briefcase.communication.transactionId
  var timestamp = microtime.now()

  var severity = briefcase.severity

  this._withCache(communicationId, function (cache) {
    cache.buffer.push({
      t: EVENT_TYPE.USER_SENT,
      r: transactionId,
      i: timestamp,
      p: communicationId,
      d: {
        n: name,
        r: payload
      }
    })
    cache.severity = severity = levels.greater(cache.severity, severity)
  })

  return { briefcase: assign({ severity: severity }, briefcase) }
}

Collector.prototype.userSentError = function (briefcase, name, error) {
  briefcase = briefcase || {}
  var communicationId = briefcase.communication && briefcase.communication.id
  var transactionId = briefcase.communication && briefcase.communication.transactionId
  var timestamp = microtime.now()

  var severity = levels.greater(briefcase.severity, levels.ERROR)

  var self = this

  this._withCache(communicationId, function (cache) {
    cache.buffer.push({
      t: EVENT_TYPE.ERROR,
      r: transactionId,
      i: timestamp,
      p: communicationId,
      d: {
        t: ERROR_TYPE.USER_SENT,
        n: name,
        r: transformError(error, self._noStack)
      }
    })
    cache.severity = severity = levels.greater(cache.severity, severity)
  })
  return { briefcase: assign({ severity: severity }, briefcase) }
}

Collector.prototype.systemError = function (briefcase, error) {
  briefcase = briefcase || {}
  var communicationId = briefcase.communication && briefcase.communication.id
  var transactionId = briefcase.communication && briefcase.communication.transactionId
  var timestamp = microtime.now()

  var severity = levels.greater(briefcase.severity, levels.CRIT)

  var self = this

  this._withCache(communicationId, function (cache) {
    cache.buffer.push({
      t: EVENT_TYPE.ERROR,
      r: transactionId,
      i: timestamp,
      p: communicationId,
      d: {
        t: ERROR_TYPE.SYSTEM,
        r: transformError(error, self._noStack)
      }
    })
    cache.severity = severity = levels.greater(cache.severity, severity)
  })
  return { briefcase: assign({ severity: severity }, briefcase) }
}

Collector.prototype.networkError = function (briefcase, error) {
  briefcase = briefcase || {}
  if (!briefcase.csCtx) {
    var err = new Error('cannot collect network error event without a CS context. Ignoring')
    debug('#networkError', '[Warning]', err.toString())
    return { briefcase: briefcase, error: err }
  }
  var communicationId = briefcase.communication && briefcase.communication.id
  var timestamp = microtime.now()

  var severity = levels.greater(briefcase.severity, levels.ERROR)

  var self = this

  this._withCache(communicationId, function (cache) {
    cache.buffer.push({
      t: EVENT_TYPE.ERROR,
      r: briefcase.csCtx.transactionId,
      i: timestamp,
      p: briefcase.csCtx.communicationId,
      d: {
        t: ERROR_TYPE.NETWORK,
        r: assign({
          code: error.code,
          host: error.host,
          port: error.port,
          syscall: error.syscall
        }, transformError(error, self._noStack))
      }
    })
    cache.severity = severity = levels.greater(cache.severity, severity)
  })
  return { briefcase: assign({ severity: severity }, briefcase) }
}

Collector.prototype.clientSend = function (payload, briefcase) {
  briefcase = briefcase || {}
  var timestamp = microtime.now()

  var parentCommunicationId = briefcase.communication && briefcase.communication.id

  var transactionId = briefcase.communication && briefcase.communication.transactionId

  if (!transactionId) {
    transactionId = uuid.v4()
  }

  var serviceKey = this.serviceKey

  var communication = {
    id: uuid.v4(),
    parentId: parentCommunicationId,
    transactionId: transactionId
  }

  var severity = briefcase.severity

  var context = {
    communicationId: communication.id,
    transactionId: transactionId
  }

  var cacheId = communication.parentId

  this._withCache(cacheId, function (cache) {
    cache.buffer.push({
      t: EVENT_TYPE.CLIENT_SEND,
      r: transactionId,
      i: timestamp,
      p: communication.id,
      c: payload.protocol,
      a: communication.parentId,
      ac: payload.action,
      e: payload.resource,
      h: payload.host,
      d: payload.data
    })
    cache.severity = severity = levels.greater(cache.severity, severity)
  })

  var duffelBag = {
    transactionId: transactionId,
    timestamp: timestamp,
    communicationId: communication.id,
    parentServiceKey: serviceKey,
    severity: severity
  }

  return {
    briefcase: assign({ severity: severity, csCtx: context }, briefcase),
    duffelBag: duffelBag
  }
}

Collector.prototype.serverRecv = function (payload, duffelBag, options) {
  briefcase = briefcase || {}
  var timestamp = microtime.now()

  var communication = {
    id: duffelBag.communicationId || uuid.v4(),
    transactionId: duffelBag.transactionId || uuid.v4()
  }

  var originTimestamp = duffelBag.timestamp
  var parentServiceKey = duffelBag.parentServiceKey

  var severity = levels.greater(duffelBag.severity, this.defaultSeverity)

  var briefcase = {
    communication: communication,
    severity: severity
  }

  this._withCache(communication.id, function (cache) {
    cache.buffer.push({
      t: EVENT_TYPE.SERVER_RECV,
      r: communication.transactionId,
      i: timestamp,
      p: communication.id,
      o: originTimestamp,
      c: payload.protocol,
      k: parentServiceKey,
      ac: payload.action,
      e: payload.resource,
      h: payload.host,
      d: payload.data
    })
    cache.severity = severity
  }, { mode: options && options.cacheMode })

  return { briefcase: briefcase }
}

Collector.prototype.serverSend = function (payload, briefcase, options) {
  briefcase = briefcase || {}
  var timestamp = microtime.now()

  if (!briefcase.communication || !briefcase.communication.transactionId) {
    var error = new Error('cannot collect SS event when not in a transaction. Ignoring')
    debug('#serverSend', '[Warning]', error.toString())
    return { briefcase: briefcase, error: error }
  }

  var communicationId = briefcase.communication.id
  var transactionId = briefcase.communication.transactionId

  var severity = briefcase.severity

  var duffelBag = {
    timestamp: timestamp,
    severity: severity,
    targetServiceKey: this.serviceKey
  }

  var self = this

  this._withCache(communicationId, function (cache) {
    cache.severity = severity = levels.greater(severity, cache.severity)
    if (!options || !options.skip) {
      cache.buffer.push({
        t: EVENT_TYPE.SERVER_SEND,
        r: transactionId,
        i: timestamp,
        p: communicationId,
        c: payload.protocol,
        s: payload.status,
        d: payload.data
      })
      if (severity <= self.mustCollectSeverity) {
        Array.prototype.push.apply(self._mustCollectBuffer, cache.buffer.elements())
      }
    }
  })

  this._deleteCache(communicationId)
  return { briefcase: assign({ severity: severity }, briefcase), duffelBag: duffelBag }
}

Collector.prototype.clientRecv = function (payload, duffelBag, briefcase) {
  briefcase = briefcase || {}
  var timestamp = microtime.now()
  if (!briefcase.csCtx) {
    debug(this.name, 'Error: cannot collect CR event without a CS context. Ignoring')
    return { briefcase: briefcase }
  }

  var communication = {
    id: briefcase.csCtx.communicationId,
    transactionId: briefcase.csCtx.transactionId,
    parentId: briefcase.communication && briefcase.communication.id
  }

  var severity = levels.greater(briefcase.severity, duffelBag.severity)

  this._withCache(communication.parentId, function (cache) {
    cache.buffer.push({
      t: EVENT_TYPE.CLIENT_RECV,
      r: communication.transactionId,
      i: timestamp,
      k: duffelBag.targetServiceKey,
      p: communication.id,
      o: duffelBag.timestamp,
      c: payload.protocol,
      a: communication.parentId,
      s: payload.status,
      d: payload.data
    })
    cache.severity = severity = levels.greater(severity, cache.severity)
  })

  return { briefcase: assign({ severity: severity }, briefcase) }
}

Collector.prototype._withCache = function (cacheId, cb, options) {
  cacheId = cacheId || 'root'
  options = options || {}
  if (this._eventBuffers[cacheId] == null) {
    if (options.noCreate) {
      return
    }
    this._eventBuffers[cacheId] = {
      severity: this.defaultSeverity,
      buffer: new ExpiringBuffer(this._eventTtl)
    }
  } else if (this._eventBuffers[cacheId].zombieTtl != null) {
    delete this._eventBuffers[cacheId].zombieTtl
    this._eventBuffers[cacheId].buffer = new ExpiringBuffer(this._eventTtl)
  }
  if (options.mode === this.CACHE_MODES.RETAIN_UNTIL_SS) {
    this._eventBuffers[cacheId].locked = true
  }
  cb(this._eventBuffers[cacheId])
}

Collector.prototype._deleteCache = function (cacheId) {
  cacheId = cacheId || 'root'
  delete this._eventBuffers[cacheId]
}

Collector.prototype.collect = function () {
  var result = []
  var self = this
  Object.keys(this._eventBuffers).forEach(function (key) {
    if (self._eventBuffers[key].locked === true) {
      return
    }
    if (self._eventBuffers[key].zombieTtl != null) {
      if ((self._eventBuffers[key].zombieTtl--) === 0) {
        delete self._eventBuffers[key]
      }
    } else if (levels.gte(self._eventBuffers[key].severity, self.mustCollectSeverity)) {
      Array.prototype.push.apply(result, self._eventBuffers[key].buffer.elements())
      delete self._eventBuffers[key].buffer
      self._eventBuffers[key].zombieTtl = self._eventTtl
    } else {
      self._eventBuffers[key].buffer.expire()
      if (self._eventBuffers[key].buffer.isEmpty()) {
        delete self._eventBuffers[key]
      }
    }
  })

  Array.prototype.push.apply(result, this._mustCollectBuffer)
  this._mustCollectBuffer = []
  return result
}

Collector.prototype.end = function (briefcase, options) {
  var communicationId = briefcase.communication.id

  var self = this
  this._withCache(communicationId, function (cache) {
    if (!options || !options.skip) {
      if (cache.severity <= self.mustCollectSeverity) {
        Array.prototype.push.apply(self._mustCollectBuffer, cache.buffer.elements())
      }
    }
  }, { noCreate: true })
  this._deleteCache(communicationId)
}

Collector.prototype.getTransactionId = function (briefcase) {
  return briefcase.communication && briefcase.communication.transactionId
}

module.exports = Collector