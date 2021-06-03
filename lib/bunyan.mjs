/**
 *
 * The bunyan logging library for node.js.
 *
 * -*- mode: js -*-
 * vim: expandtab:ts=4:sw=4
 */

import os from 'os'
import fs from 'fs'
import util from 'util'
import path from 'path'
import assert from 'assert'
import events from 'events'
import stream from 'stream'
import { fileURLToPath } from 'url'
import safeJson from './safe-json.mjs'

const EventEmitter = events.EventEmitter

/*
 * Bunyan log format version. This becomes the 'v' field on all log records.
 * This will be incremented if there is any backward incompatible change to
 * the log record format. Details will be in 'CHANGES.md' (the change log).
 */
const LOG_VERSION = 0;


var xxx = function xxx(s) {     // internal dev/debug logging
  var args = ['XX' + 'X: '+s].concat(
    Array.prototype.slice.call(arguments, 1));
  console.error.apply(this, args);
};
var xxx = function xxx() {};  // comment out to turn on debug logging

//---- Internal support stuff

/**
 * A shallow copy of an object. Bunyan logging attempts to never cause
 * exceptions, so this function attempts to handle non-objects gracefully.
 */
function objCopy(obj) {
  if (obj == null) {  // null or undefined
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.slice();
  } else if (typeof (obj) === 'object') {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
      copy[k] = obj[k];
    });
    return copy;
  } else {
    return obj;
  }
}

var format = util.format;
if (!format) {
  // If node < 0.6, then use its `util.format`:
  // <https://github.com/joyent/node/blob/master/lib/util.js#L22>:
  var inspect = util.inspect;
  var formatRegExp = /%[sdj%]/g;
  format = function format(f) {
    if (typeof (f) !== 'string') {
      var objects = [];
      for (var i = 0; i < arguments.length; i++) {
        objects.push(inspect(arguments[i]));
      }
      return objects.join(' ');
    }

    var i = 1;
    var args = arguments;
    var len = args.length;
    var str = String(f).replace(formatRegExp, function (x) {
      if (i >= len)
        return x;
      switch (x) {
        case '%s': return String(args[i++]);
        case '%d': return Number(args[i++]);
        case '%j': return fastAndSafeJsonStringify(args[i++]);
        case '%%': return '%';
        default:
          return x;
      }
    });
    for (var x = args[i]; i < len; x = args[++i]) {
      if (x === null || typeof (x) !== 'object') {
        str += ' ' + x;
      } else {
        str += ' ' + inspect(x);
      }
    }
    return str;
  };
}


function _indent(s, indent) {
  if (!indent) indent = '    ';
  var lines = s.split(/\r?\n/g);
  return indent + lines.join('\n' + indent);
}


/**
 * Warn about an bunyan processing error.
 *
 * @param msg {String} Message with which to warn.
 * @param dedupKey {String} Optional. A short string key for this warning to
 *      have its warning only printed once.
 */
function _warn(msg, dedupKey) {
  assert.ok(msg);
  if (dedupKey) {
    if (_warned[dedupKey]) {
      return;
    }
    _warned[dedupKey] = true;
  }
  process.stderr.write(msg + '\n');
}
function _haveWarned(dedupKey) {
  return _warned[dedupKey];
}
var _warned = {};


function ConsoleRawStream() {}
ConsoleRawStream.prototype.write = function (rec) {
  if (rec.level < INFO) {
    console.log(rec);
  } else if (rec.level < WARN) {
    console.info(rec);
  } else if (rec.level < ERROR) {
    console.warn(rec);
  } else {
    console.error(rec);
  }
};


//---- Levels

var TRACE = 10;
var DEBUG = 20;
var INFO = 30;
var WARN = 40;
var ERROR = 50;
var FATAL = 60;

var levelFromName = {
  'trace': TRACE,
  'debug': DEBUG,
  'info': INFO,
  'warn': WARN,
  'error': ERROR,
  'fatal': FATAL
};
var nameFromLevel = {};
Object.keys(levelFromName).forEach(function (name) {
  nameFromLevel[levelFromName[name]] = name;
});

/**
 * Resolve a level number, name (upper or lowercase) to a level number value.
 *
 * @param nameOrNum {String|Number} A level name (case-insensitive) or positive
 *      integer level.
 * @api public
 */
function resolveLevel(nameOrNum) {
  var level;
  var type = typeof (nameOrNum);
  if (type === 'string') {
    level = levelFromName[nameOrNum.toLowerCase()];
    if (!level) {
      throw new Error(format('unknown level name: "%s"', nameOrNum));
    }
  } else if (type !== 'number') {
    throw new TypeError(format('cannot resolve level: invalid arg (%s):',
      type, nameOrNum));
  } else if (nameOrNum < 0 || Math.floor(nameOrNum) !== nameOrNum) {
    throw new TypeError(format('level is not a positive integer: %s',
      nameOrNum));
  } else {
    level = nameOrNum;
  }
  return level;
}


function isWritable(obj) {
  if (obj instanceof stream.Writable) {
    return true;
  }
  return typeof (obj.write) === 'function';
}


//---- Logger class

/**
 * Create a Logger instance.
 *
 * @param options {Object} See documentation for full details. At minimum
 *    this must include a 'name' string key. Configuration keys:
 *      - `streams`: specify the logger output streams. This is an array of
 *        objects with these fields:
 *          - `type`: The stream type. See README.md for full details.
 *            Often this is implied by the other fields. Examples are
 *            'file', 'stream' and "raw".
 *          - `level`: Defaults to 'info'.
 *          - `path` or `stream`: The specify the file path or writeable
 *            stream to which log records are written. E.g.
 *            `stream: process.stdout`.
 *          - `closeOnExit` (boolean): Optional. Default is true for a
 *            'file' stream when `path` is given, false otherwise.
 *        See README.md for full details.
 *      - `level`: set the level for a single output stream (cannot be used
 *        with `streams`)
 *      - `stream`: the output stream for a logger with just one, e.g.
 *        `process.stdout` (cannot be used with `streams`)
 *      - `serializers`: object mapping log record field names to
 *        serializing functions. See README.md for details.
 *      - `src`: Boolean (default false). Set true to enable 'src' automatic
 *        field with log call source info.
 *    All other keys are log record fields.
 *
 * An alternative *internal* call signature is used for creating a child:
 *    new Logger(<parent logger>, <child options>[, <child opts are simple>]);
 *
 * @param _childSimple (Boolean) An assertion that the given `_childOptions`
 *    (a) only add fields (no config) and (b) no serialization handling is
 *    required for them. IOW, this is a fast path for frequent child
 *    creation.
 */
function Logger(options, _childOptions, _childSimple) {
  xxx('Logger start:', options)
  if (!(this instanceof Logger)) {
    return new Logger(options, _childOptions);
  }

  // Input arg validation.
  var parent;
  if (_childOptions !== undefined) {
    parent = options;
    options = _childOptions;
    if (!(parent instanceof Logger)) {
      throw new TypeError(
        'invalid Logger creation: do not pass a second arg');
    }
  }
  if (!options) {
    throw new TypeError('options (object) is required');
  }
  if (!parent) {
    if (!options.name) {
      throw new TypeError('options.name (string) is required');
    }
  } else {
    if (options.name) {
      throw new TypeError(
        'invalid options.name: child cannot set logger name');
    }
  }
  if (options.stream && options.streams) {
    throw new TypeError('cannot mix "streams" and "stream" options');
  }
  if (options.streams && !Array.isArray(options.streams)) {
    throw new TypeError('invalid options.streams: must be an array')
  }
  if (options.serializers && (typeof (options.serializers) !== 'object' ||
      Array.isArray(options.serializers))) {
    throw new TypeError('invalid options.serializers: must be an object')
  }

  EventEmitter.call(this);

  // Fast path for simple child creation.
  if (parent && _childSimple) {
    // `_isSimpleChild` is a signal to stream close handling that this child
    // owns none of its streams.
    this._isSimpleChild = true;

    this._level = parent._level;
    this.streams = parent.streams;
    this.serializers = parent.serializers;
    var fields = this.fields = {};
    var parentFieldNames = Object.keys(parent.fields);
    for (var i = 0; i < parentFieldNames.length; i++) {
      var name = parentFieldNames[i];
      fields[name] = parent.fields[name];
    }
    var names = Object.keys(options);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      fields[name] = options[name];
    }
    return;
  }

  // Start values.
  var self = this;
  if (parent) {
    this._level = parent._level;
    this.streams = [];
    for (var i = 0; i < parent.streams.length; i++) {
      var s = objCopy(parent.streams[i]);
      s.closeOnExit = false; // Don't own parent stream.
      this.streams.push(s);
    }
    this.serializers = objCopy(parent.serializers);
    this.fields = objCopy(parent.fields);
    if (options.level) {
      this.level(options.level);
    }
  } else {
    this._level = Number.POSITIVE_INFINITY;
    this.streams = [];
    this.serializers = null;
    this.fields = {};
  }

  // Handle *config* options (i.e. options that are not just plain data
  // for log records).
  if (options.stream) {
    self.addStream({
      type: 'stream',
      stream: options.stream,
      closeOnExit: false,
      level: options.level
    });
  } else if (options.streams) {
    options.streams.forEach(function (s) {
      self.addStream(s, options.level);
    });
  } else if (parent && options.level) {
    this.level(options.level);
  } else if (!parent) {
    self.addStream({
      type: 'stream',
      stream: process.stdout,
      closeOnExit: false,
      level: options.level
    });
  }
  if (options.serializers) {
    self.addSerializers(options.serializers);
  }
  xxx('Logger: ', self)

  // Fields.
  // These are the default fields for log records (minus the attributes
  // removed in this constructor). To allow storing raw log records
  // (unrendered), `this.fields` must never be mutated. Create a copy for
  // any changes.
  var fields = objCopy(options);
  delete fields.stream;
  delete fields.level;
  delete fields.streams;
  delete fields.serializers;
  if (this.serializers) {
    this._applySerializers(fields);
  }
  if (!fields.hostname && !self.fields.hostname) {
    fields.hostname = os.hostname();
  }
  if (!fields.pid) {
    fields.pid = process.pid;
  }
  Object.keys(fields).forEach(function (k) {
    self.fields[k] = fields[k];
  });
}

util.inherits(Logger, EventEmitter);


/**
 * Add a stream
 *
 * @param stream {Object}. Object with these fields:
 *    - `type`: The stream type. See README.md for full details.
 *      Often this is implied by the other fields. Examples are
 *      'file', 'stream' and "raw".
 *    - `path` or `stream`: The specify the file path or writeable
 *      stream to which log records are written. E.g.
 *      `stream: process.stdout`.
 *    - `level`: Optional. Falls back to `defaultLevel`.
 *    - `closeOnExit` (boolean): Optional. Default is true for a
 *      'file' stream when `path` is given, false otherwise.
 *    See README.md for full details.
 * @param defaultLevel {Number|String} Optional. A level to use if
 *      `stream.level` is not set. If neither is given, this defaults to INFO.
 */
Logger.prototype.addStream = function addStream(s, defaultLevel) {
  var self = this;
  if (defaultLevel === null || defaultLevel === undefined) {
    defaultLevel = INFO;
  }

  s = objCopy(s);

  // Implicit 'type' from other args.
  if (!s.type) {
    if (s.stream) {
      s.type = 'stream';
    } else if (s.path) {
      s.type = 'file'
    }
  }
  s.raw = (s.type === 'raw');  // PERF: Allow for faster check in `_emit`.

  if (s.level !== undefined) {
    s.level = resolveLevel(s.level);
  } else {
    s.level = resolveLevel(defaultLevel);
  }
  if (s.level < self._level) {
    self._level = s.level;
  }

  switch (s.type) {
  case 'stream':
    assert.ok(isWritable(s.stream),
          '"stream" stream is not writable: ' + util.inspect(s.stream));

    if (!s.closeOnExit) {
      s.closeOnExit = false;
    }
    break;
  case 'file':
    if (s.reemitErrorEvents === undefined) {
      s.reemitErrorEvents = true;
    }
    if (!s.stream) {
      s.stream = fs.createWriteStream(s.path,
                      {flags: 'a', encoding: 'utf8'});
      if (!s.closeOnExit) {
        s.closeOnExit = true;
      }
    } else {
      if (!s.closeOnExit) {
        s.closeOnExit = false;
      }
    }
    break;
  case 'raw':
    if (!s.closeOnExit) {
      s.closeOnExit = false;
    }
    break;
  default:
    throw new TypeError('unknown stream type "' + s.type + '"');
  }

  if (s.reemitErrorEvents && typeof (s.stream.on) === 'function') {
    // TODO: When we have `<logger>.close()`, it should remove event
    //      listeners to not leak Logger instances.
    s.stream.on('error', function onStreamError(err) {
      self.emit('error', err, s);
    });
  }

  self.streams.push(s);
  delete self.haveNonRawStreams;  // reset
}


/**
 * Add serializers
 *
 * @param serializers {Object} Optional. Object mapping log record field names
 *    to serializing functions. See README.md for details.
 */
Logger.prototype.addSerializers = function addSerializers(serializers) {
  var self = this;

  if (!self.serializers) {
    self.serializers = {};
  }
  Object.keys(serializers).forEach(function (field) {
    var serializer = serializers[field];
    if (typeof (serializer) !== 'function') {
      throw new TypeError(format(
        'invalid serializer for "%s" field: must be a function',
        field));
    } else {
      self.serializers[field] = serializer;
    }
  });
}



/**
 * Create a child logger, typically to add a few log record fields.
 *
 * This can be useful when passing a logger to a sub-component, e.g. a
 * 'wuzzle' component of your service:
 *
 *    var wuzzleLog = log.child({component: 'wuzzle'})
 *    var wuzzle = new Wuzzle({..., log: wuzzleLog})
 *
 * Then log records from the wuzzle code will have the same structure as
 * the app log, *plus the component='wuzzle' field*.
 *
 * @param options {Object} Optional. Set of options to apply to the child.
 *    All of the same options for a new Logger apply here. Notes:
 *      - The parent's streams are inherited and cannot be removed in this
 *        call. Any given `streams` are *added* to the set inherited from
 *        the parent.
 *      - The parent's serializers are inherited, though can effectively be
 *        overwritten by using duplicate keys.
 *      - Can use `level` to set the level of the streams inherited from
 *        the parent. The level for the parent is NOT affected.
 * @param simple {Boolean} Optional. Set to true to assert that `options`
 *    (a) only add fields (no config) and (b) no serialization handling is
 *    required for them. IOW, this is a fast path for frequent child
 *    creation. See 'tools/timechild.js' for numbers.
 */
Logger.prototype.child = function (options, simple) {
  return new (this.constructor)(this, options || {}, simple);
}


/**
 * A convenience method to reopen 'file' streams on a logger. This can be
 * useful with external log rotation utilities that move and re-open log files
 * (e.g. logrotate on Linux, logadm on SmartOS/Illumos). Those utilities
 * typically have rotation options to copy-and-truncate the log file, but
 * you may not want to use that. An alternative is to do this in your
 * application:
 *
 *      var log = bunyan.createLogger(...);
 *      ...
 *      process.on('SIGUSR2', function () {
 *          log.reopenFileStreams();
 *      });
 *      ...
 *
 * See <https://github.com/trentm/node-bunyan/issues/104>.
 */
Logger.prototype.reopenFileStreams = function () {
  var self = this;
  self.streams.forEach(function (s) {
    if (s.type === 'file') {
      if (s.stream) {
        // Not sure if typically would want this, or more immediate
        // `s.stream.destroy()`.
        s.stream.end();
        s.stream.destroySoon();
        delete s.stream;
      }
      s.stream = fs.createWriteStream(s.path,
        {flags: 'a', encoding: 'utf8'});
      s.stream.on('error', function (err) {
        self.emit('error', err, s);
      });
    }
  });
};


/* BEGIN JSSTYLED */
/**
 * Close this logger.
 *
 * This closes streams (that it owns, as per 'endOnClose' attributes on
 * streams), etc. Typically you **don't** need to bother calling this.
Logger.prototype.close = function () {
  if (this._closed) {
    return;
  }
  if (!this._isSimpleChild) {
    self.streams.forEach(function (s) {
      if (s.endOnClose) {
        xxx('closing stream s:', s);
        s.stream.end();
        s.endOnClose = false;
      }
    });
  }
  this._closed = true;
}
 */
/* END JSSTYLED */


/**
 * Get/set the level of all streams on this logger.
 *
 * Get Usage:
 *    // Returns the current log level (lowest level of all its streams).
 *    log.level() -> INFO
 *
 * Set Usage:
 *    log.level(INFO)       // set all streams to level INFO
 *    log.level('info')     // can use 'info' et al aliases
 */
Logger.prototype.level = function level(value) {
  if (value === undefined) {
    return this._level;
  }
  var newLevel = resolveLevel(value);
  var len = this.streams.length;
  for (var i = 0; i < len; i++) {
    this.streams[i].level = newLevel;
  }
  this._level = newLevel;
}


/**
 * Get/set the level of a particular stream on this logger.
 *
 * Get Usage:
 *    // Returns an array of the levels of each stream.
 *    log.levels() -> [TRACE, INFO]
 *
 *    // Returns a level of the identified stream.
 *    log.levels(0) -> TRACE      // level of stream at index 0
 *    log.levels('foo')           // level of stream with name 'foo'
 *
 * Set Usage:
 *    log.levels(0, INFO)         // set level of stream 0 to INFO
 *    log.levels(0, 'info')       // can use 'info' et al aliases
 *    log.levels('foo', WARN)     // set stream named 'foo' to WARN
 *
 * Stream names: When streams are defined, they can optionally be given
 * a name. For example,
 *       log = new Logger({
 *         streams: [
 *           {
 *             name: 'foo',
 *             path: '/var/log/my-service/foo.log'
 *             level: 'trace'
 *           },
 *         ...
 *
 * @param name {String|Number} The stream index or name.
 * @param value {Number|String} The level value (INFO) or alias ('info').
 *    If not given, this is a 'get' operation.
 * @throws {Error} If there is no stream with the given name.
 */
Logger.prototype.levels = function levels(name, value) {
  if (name === undefined) {
    assert.equal(value, undefined);
    return this.streams.map(
      function (s) { return s.level });
  }
  var stream;
  if (typeof (name) === 'number') {
    stream = this.streams[name];
    if (stream === undefined) {
      throw new Error('invalid stream index: ' + name);
    }
  } else {
    var len = this.streams.length;
    for (var i = 0; i < len; i++) {
      var s = this.streams[i];
      if (s.name === name) {
        stream = s;
        break;
      }
    }
    if (!stream) {
      throw new Error(format('no stream with name "%s"', name));
    }
  }
  if (value === undefined) {
    return stream.level;
  } else {
    var newLevel = resolveLevel(value);
    stream.level = newLevel;
    if (newLevel < this._level) {
      this._level = newLevel;
    }
  }
}


/**
 * Apply registered serializers to the appropriate keys in the given fields.
 *
 * Pre-condition: This is only called if there is at least one serializer.
 *
 * @param fields (Object) The log record fields.
 * @param excludeFields (Object) Optional mapping of keys to `true` for
 *    keys to NOT apply a serializer.
 */
Logger.prototype._applySerializers = function (fields, excludeFields) {
  var self = this;

  xxx('_applySerializers: excludeFields', excludeFields);

  // Check each serializer against these (presuming number of serializers
  // is typically less than number of fields).
  Object.keys(this.serializers).forEach(function (name) {
    if (fields[name] === undefined ||
      (excludeFields && excludeFields[name]))
    {
      return;
    }
    xxx('_applySerializers; apply to "%s" key', name)
    try {
      fields[name] = self.serializers[name](fields[name]);
    } catch (err) {
      _warn(format('bunyan: ERROR: Exception thrown from the "%s" '
        + 'Bunyan serializer. This should never happen. This is a bug '
        + 'in that serializer function.\n%s',
        name, err.stack || err));
      fields[name] = format('(Error in Bunyan log "%s" serializer '
        + 'broke field. See stderr for details.)', name);
    }
  });
}


/**
 * Emit a log record.
 *
 * @param rec {log record}
 * @param noemit {Boolean} Optional. Set to true to skip emission
 *      and just return the JSON string.
 */
Logger.prototype._emit = function (rec, noemit) {
  var i;

  // Lazily determine if this Logger has non-'raw' streams. If there are
  // any, then we need to stringify the log record.
  if (this.haveNonRawStreams === undefined) {
    this.haveNonRawStreams = false;
    for (i = 0; i < this.streams.length; i++) {
      if (!this.streams[i].raw) {
        this.haveNonRawStreams = true;
        break;
      }
    }
  }

  // Stringify the object (creates a warning str on error).
  var str;
  if (noemit || this.haveNonRawStreams) {
    str = fastAndSafeJsonStringify(rec) + '\n';
  }

  if (noemit)
    return str;

  var level = rec.level;
  for (i = 0; i < this.streams.length; i++) {
    var s = this.streams[i];
    if (s.level <= level) {
      xxx('writing log rec "%s" to "%s" stream (%d <= %d): %j',
        rec.msg, s.type, s.level, level, rec);
      s.stream.write(s.raw ? rec : str);
    }
  };

  return str;
}


/**
 * Build a record object suitable for emitting from the arguments
 * provided to the a log emitter.
 */
function mkRecord(log, minLevel, args) {
  var excludeFields, fields, msgArgs;
  if (args[0] instanceof Error) {
    // `log.<level>(err, ...)`
    fields = {
      // Use this Logger's err serializer, if defined.
      err: (log.serializers && log.serializers.err
        ? log.serializers.err(args[0])
        : Logger.stdSerializers.err(args[0]))
    };
    excludeFields = {err: true};
    if (args.length === 1) {
      msgArgs = [fields.err.message];
    } else {
      msgArgs = args.slice(1);
    }
  } else if (typeof (args[0]) !== 'object' || Array.isArray(args[0])) {
    // `log.<level>(msg, ...)`
    fields = null;
    msgArgs = args.slice();
  } else if (Buffer.isBuffer(args[0])) {  // `log.<level>(buf, ...)`
    // Almost certainly an error, show `inspect(buf)`. See bunyan
    // issue #35.
    fields = null;
    msgArgs = args.slice();
    msgArgs[0] = util.inspect(msgArgs[0]);
  } else {  // `log.<level>(fields, msg, ...)`
    fields = args[0];
    if (fields && args.length === 1 && fields.err &&
      fields.err instanceof Error)
    {
      msgArgs = [fields.err.message];
    } else {
      msgArgs = args.slice(1);
    }
  }

  // Build up the record object.
  var rec = objCopy(log.fields);
  var level = rec.level = minLevel;
  var recFields = (fields ? objCopy(fields) : null);
  if (recFields) {
    if (log.serializers) {
      log._applySerializers(recFields, excludeFields);
    }
    Object.keys(recFields).forEach(function (k) {
      rec[k] = recFields[k];
    });
  }
  rec.msg = format.apply(log, msgArgs);
  if (!rec.time) {
    rec.time = (new Date());
  }
  rec.v = LOG_VERSION;

  return rec;
};


/**
 * Build a log emitter function for level minLevel. I.e. this is the
 * creator of `log.info`, `log.error`, etc.
 */
function mkLogEmitter(minLevel) {
  return function () {
    var log = this;
    var str = null;
    var rec = null;

    if (!this._emit) {
      /*
       * Show this invalid Bunyan usage warning *once*.
       *
       * See <https://github.com/trentm/node-bunyan/issues/100> for
       * an example of how this can happen.
       */
      var dedupKey = 'unbound';
      if (!_haveWarned[dedupKey]) {
        _warn(format('bunyan usage error: Attempt to log '
          + 'with an unbound log method: `this` is: %s', util.inspect(this)),
          dedupKey);
      }
      return;
    } else if (arguments.length === 0) {   // `log.<level>()`
      return (this._level <= minLevel);
    }

    var msgArgs = new Array(arguments.length);
    for (var i = 0; i < msgArgs.length; ++i) {
      msgArgs[i] = arguments[i];
    }

    if (this._level <= minLevel) {
      rec = mkRecord(log, minLevel, msgArgs);
      str = this._emit(rec);
    }
  }
}


/**
 * The functions below log a record at a specific level.
 *
 * Usages:
 *    log.<level>()  -> boolean is-trace-enabled
 *    log.<level>(<Error> err, [<string> msg, ...])
 *    log.<level>(<string> msg, ...)
 *    log.<level>(<object> fields, <string> msg, ...)
 *
 * where <level> is the lowercase version of the log level. E.g.:
 *
 *    log.info()
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.trace = mkLogEmitter(TRACE);
Logger.prototype.debug = mkLogEmitter(DEBUG);
Logger.prototype.info = mkLogEmitter(INFO);
Logger.prototype.warn = mkLogEmitter(WARN);
Logger.prototype.error = mkLogEmitter(ERROR);
Logger.prototype.fatal = mkLogEmitter(FATAL);



//---- Standard serializers
// A serializer is a function that serializes a JavaScript object to a
// JSON representation for logging. There is a standard set of presumed
// interesting objects in node.js-land.

Logger.stdSerializers = {};

// Serialize an HTTP request.
Logger.stdSerializers.req = function (req) {
  if (!req || !req.connection)
    return req;
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    remoteAddress: req.connection.remoteAddress,
    remotePort: req.connection.remotePort
  };
  // Trailers: Skipping for speed. If you need trailers in your app, then
  // make a custom serializer.
  //if (Object.keys(trailers).length > 0) {
  //  obj.trailers = req.trailers;
  //}
};

// Serialize an HTTP response.
Logger.stdSerializers.res = function (res) {
  if (!res || !res.statusCode)
    return res;
  return {
    statusCode: res.statusCode,
    header: res._header
  }
};


/*
 * This function dumps long stack traces for exceptions having a cause()
 * method. The error classes from
 * [verror](https://github.com/davepacheco/node-verror) and
 * [restify v2.0](https://github.com/mcavage/node-restify) are examples.
 *
 * Based on `dumpException` in
 * https://github.com/davepacheco/node-extsprintf/blob/master/lib/extsprintf.js
 */
function getFullErrorStack(ex)
{
  var ret = ex.stack || ex.toString();
  if (ex.cause && typeof (ex.cause) === 'function') {
    var cex = ex.cause();
    if (cex) {
      ret += '\nCaused by: ' + getFullErrorStack(cex);
    }
  }
  return (ret);
}

// Serialize an Error object
// (Core error properties are enumerable in node 0.4, not in 0.6).
Logger.stdSerializers.err = function (err) {
  if (!err || !err.stack)
    return err;
  var obj = {
    message: err.message,
    name: err.name,
    stack: getFullErrorStack(err),
    code: err.code,
    signal: err.signal
  }
  return obj;
};


// A JSON stringifier that handles cycles safely - tracks seen values in a Set.
function safeCyclesSet() {
  var seen = new Set();
  return function (key, val) {
    if (!val || typeof (val) !== 'object') {
      return val;
    }
    if (seen.has(val)) {
      return '[Circular]';
    }
    seen.add(val);
    return val;
  };
}

/**
 * A JSON stringifier that handles cycles safely - tracks seen vals in an Array.
 *
 * Note: This approach has performance problems when dealing with large objects,
 * see trentm/node-bunyan#445, but since this is the only option for node 0.10
 * and earlier (as Set was introduced in Node 0.12), it's used as a fallback
 * when Set is not available.
 */
function safeCyclesArray() {
  var seen = [];
  return function (key, val) {
    if (!val || typeof (val) !== 'object') {
      return val;
    }
    if (seen.indexOf(val) !== -1) {
      return '[Circular]';
    }
    seen.push(val);
    return val;
  };
}

/**
 * A JSON stringifier that handles cycles safely.
 *
 * Usage: JSON.stringify(obj, safeCycles())
 *
 * Choose the best safe cycle function from what is available - see
 * trentm/node-bunyan#445.
 */
var safeCycles = typeof (Set) !== 'undefined' ? safeCyclesSet : safeCyclesArray;

/**
 * A fast JSON.stringify that handles cycles and getter exceptions (when
 * safeJsonStringify is installed).
 *
 * This function attempts to use the regular JSON.stringify for speed, but on
 * error (e.g. JSON cycle detection exception) it falls back to safe stringify
 * handlers that can deal with cycles and/or getter exceptions.
 */
function fastAndSafeJsonStringify(rec) {
  try {
    return JSON.stringify(rec);
  } catch (ex) {
    try {
      return JSON.stringify(rec, safeCycles());
    } catch (e) {
      if (!process.env.BUNYAN_TEST_NO_SAFE_JSON_STRINGIFY) {
        return safeJson(rec);
      } else {
        var dedupKey = e.stack.split(/\n/g, 3).join('\n');
        _warn('bunyan: ERROR: Exception in '
          + '`JSON.stringify(rec)`. You can install the '
          + '"safe-json-stringify" module to have Bunyan fallback '
          + 'to safer stringification. Record:\n'
          + _indent(format('%s\n%s', util.inspect(rec), e.stack)),
          dedupKey);
        return format('(Exception in JSON.stringify(rec): %j. '
          + 'See stderr for details.)', e.message);
      }
    }
  }
}


/**
 * RingBuffer is a Writable Stream that just stores the last N records in
 * memory.
 *
 * @param options {Object}, with the following fields:
 *
 *    - limit: number of records to keep in memory
 */
function RingBuffer(options) {
  this.limit = options && options.limit ? options.limit : 100;
  this.writable = true;
  this.records = [];
  EventEmitter.call(this);
}

util.inherits(RingBuffer, EventEmitter);

RingBuffer.prototype.write = function (record) {
  if (!this.writable)
    throw (new Error('RingBuffer has been ended already'));

  this.records.push(record);

  if (this.records.length > this.limit)
    this.records.shift();

  return (true);
};

RingBuffer.prototype.end = function () {
  if (arguments.length > 0)
    this.write.apply(this, Array.prototype.slice.call(arguments));
  this.writable = false;
};

RingBuffer.prototype.destroy = function () {
  this.writable = false;
  this.emit('close');
};

RingBuffer.prototype.destroySoon = function () {
  this.destroy();
};


let __dirname = path.dirname(fileURLToPath(import.meta.url))
let pckg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json')))
const version = pckg.version

//---- Exports

Logger.TRACE = TRACE;
Logger.DEBUG = DEBUG;
Logger.INFO = INFO;
Logger.WARN = WARN;
Logger.ERROR = ERROR;
Logger.FATAL = FATAL;
Logger.resolveLevel = resolveLevel;
Logger.levelFromName = levelFromName;
Logger.nameFromLevel = nameFromLevel;

Logger.VERSION = version;
Logger.LOG_VERSION = LOG_VERSION;

Logger.createLogger = function createLogger(options) {
  return new Logger(options);
};

Logger.RingBuffer = RingBuffer;

// Useful for custom `type == 'raw'` streams that may do JSON stringification
// of log records themselves. Usage:
//    var str = JSON.stringify(rec, bunyan.safeCycles());
Logger.safeCycles = safeCycles;

export default Logger