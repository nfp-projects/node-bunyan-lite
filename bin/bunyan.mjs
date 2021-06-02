#!/usr/bin/env node
/**
 *
 * bunyan -- filter and pretty-print Bunyan log files (line-delimited JSON)
 *
 * See <https://github.com/trentm/node-bunyan>.
 *
 * -*- mode: js -*-
 * vim: expandtab:ts=4:sw=4
 */

var p = console.log;

import util from 'util'
import vm from 'vm'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { spawn } from 'child_process'
import { createGunzip } from 'zlib'
import { StringDecoder } from 'string_decoder'
import { fileURLToPath } from 'url'
import assert from 'assert'
var warn = console.warn;

//---- globals and constants

var nodeVer = process.versions.node.split('.').map(Number);
var nodeSpawnSupportsStdio = (nodeVer[0] > 0 || nodeVer[1] >= 8);

// Internal debug logging via `console.warn`.
var _selfTrace = function selfTraceNoop() {};
if (process.env.BUNYAN_SELF_TRACE === '1') {
  _selfTrace = function selfTrace() {
    process.stderr.write('[bunyan self-trace] ');
    console.warn.apply(null, arguments);
  }
}

// Output modes.
var OM_LONG = 1;
var OM_JSON = 2;
var OM_INSPECT = 3;
var OM_SIMPLE = 4;
var OM_SHORT = 5;
var OM_BUNYAN = 6;
var OM_FROM_NAME = {
  'long': OM_LONG,
  'paul': OM_LONG,  /* backward compat */
  'json': OM_JSON,
  'inspect': OM_INSPECT,
  'simple': OM_SIMPLE,
  'short': OM_SHORT,
  'bunyan': OM_BUNYAN
};


// Levels
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
var upperNameFromLevel = {};
var upperPaddedNameFromLevel = {};
Object.keys(levelFromName).forEach(function (name) {
  var lvl = levelFromName[name];
  nameFromLevel[lvl] = name;
  upperNameFromLevel[lvl] = name.toUpperCase();
  upperPaddedNameFromLevel[lvl] = (
    name.length === 4 ? ' ' : '') + name.toUpperCase();
});


// Display time formats.
var TIME_UTC = 1;  // the default, bunyan's native format
var TIME_LOCAL = 2;


// Boolean set to true when we are in the process of exiting. We don't always
// hard-exit (e.g. when staying alive while the pager completes).
var exiting = false;

// The current raw input line being processed. Used for `uncaughtException`.
var currLine = null;

// Whether ANSI codes are being used. Used for signal-handling.
var usingAnsiCodes = false;

// Used to tell the 'uncaughtException' handler that '-c CODE' is being used.
var gUsingConditionOpts = false;

// Pager child process, and output stream to which to write.
var pager = null;
var stdout = process.stdout;



//---- support functions

var _version = null;
function getVersion() {
  if (_version === null) {
    let __dirname = path.dirname(fileURLToPath(import.meta.url))
    let pckg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json')))
    _version = pckg.version
  }
  return _version;
}


var format = util.format;
if (!format) {
  /* BEGIN JSSTYLED */
  // If not node 0.6, then use its `util.format`:
  // <https://github.com/joyent/node/blob/master/lib/util.js#L22>:
  var inspect = util.inspect;
  var formatRegExp = /%[sdj%]/g;
  format = function format(f) {
    if (typeof f !== 'string') {
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
        case '%j': return JSON.stringify(args[i++]);
        case '%%': return '%';
        default:
          return x;
      }
    });
    for (var x = args[i]; i < len; x = args[++i]) {
      if (x === null || typeof x !== 'object') {
        str += ' ' + x;
      } else {
        str += ' ' + inspect(x);
      }
    }
    return str;
  };
  /* END JSSTYLED */
}

function indent(s) {
  return '    ' + s.split(/\r?\n/).join('\n    ');
}

function objCopy(obj) {
  if (obj === null) {
    return null;
  } else if (Array.isArray(obj)) {
    return obj.slice();
  } else {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
      copy[k] = obj[k];
    });
    return copy;
  }
}

function printHelp() {
  /* BEGIN JSSTYLED */
  p('Usage:');
  p('  bunyan [OPTIONS] [FILE ...]');
  p('  ... | bunyan [OPTIONS]');
  p('  bunyan [OPTIONS] -p PID');
  p('');
  p('Filter and pretty-print Bunyan log file content.');
  p('');
  p('General options:');
  p('  -h, --help    print this help info and exit');
  p('  --version     print version of this command and exit');
  p('');
  p('Filtering options:');
  p('  -l, --level LEVEL');
  p('                Only show messages at or above the specified level.');
  p('                You can specify level *names* or the internal numeric');
  p('                values.');
  p('  -c, --condition CONDITION');
  p('                Run each log message through the condition and');
  p('                only show those that return truish. E.g.:');
  p('                    -c \'this.pid == 123\'');
  p('                    -c \'this.level == DEBUG\'');
  p('                    -c \'this.msg.indexOf("boom") != -1\'');
  p('                "CONDITION" must be legal JS code. `this` holds');
  p('                the log record. The TRACE, DEBUG, ... FATAL values');
  p('                are defined to help with comparing `this.level`.');
  p('  --strict      Suppress all but legal Bunyan JSON log lines. By default');
  p('                non-JSON, and non-Bunyan lines are passed through.');
  p('');
  p('Output options:');
  p('  --pager       Pipe output into `less` (or $PAGER if set), if');
  p('                stdout is a TTY. This overrides $BUNYAN_NO_PAGER.');
  p('                Note: Paging is only supported on node >=0.8.');
  p('  --no-pager    Do not pipe output into a pager.');
  p('  --color       Colorize output. Defaults to try if output');
  p('                stream is a TTY.');
  p('  --no-color    Force no coloring (e.g. terminal doesn\'t support it)');
  p('  -o, --output MODE');
  p('                Specify an output mode/format. One of');
  p('                  long: (the default) pretty');
  p('                  json: JSON output, 2-space indent');
  p('                  json-N: JSON output, N-space indent, e.g. "json-4"');
  p('                  bunyan: 0 indented JSON, bunyan\'s native format');
  p('                  inspect: node.js `util.inspect` output');
  p('                  short: like "long", but more concise');
  p('                  simple: level, followed by "-" and then the message');
  p('  -j            shortcut for `-o json`');
  p('  -0            shortcut for `-o bunyan`');
  p('');
  p('Environment Variables:');
  p('  BUNYAN_NO_COLOR    Set to a non-empty value to force no output ');
  p('                     coloring. See "--no-color".');
  p('  BUNYAN_NO_PAGER    Disable piping output to a pager. ');
  p('                     See "--no-pager".');
  p('');
  p('See <https://github.com/trentm/node-bunyan> for more complete docs.');
  p('Please report bugs to <https://github.com/trentm/node-bunyan/issues>.');
  /* END JSSTYLED */
}

/*
 * If the user specifies multiple input sources, we want to print out records
 * from all sources in a single, chronologically ordered stream.  To do this
 * efficiently, we first assume that all records within each source are ordered
 * already, so we need only keep track of the next record in each source and
 * the time of the last record emitted.  To avoid excess memory usage, we
 * pause() streams that are ahead of others.
 *
 * 'streams' is an object indexed by source name (file name) which specifies:
 *
 *    stream        Actual stream object, so that we can pause and resume it.
 *
 *    records       Array of log records we've read, but not yet emitted.  Each
 *                  record includes 'line' (the raw line), 'rec' (the JSON
 *                  record), and 'time' (the parsed time value).
 *
 *    done          Whether the stream has any more records to emit.
 */
var streams = {};

function gotRecord(file, line, rec, opts, stylize)
{
  var time = new Date(rec.time);

  streams[file]['records'].push({ line: line, rec: rec, time: time });
  emitNextRecord(opts, stylize);
}

function filterRecord(rec, opts)
{
  if (opts.level && rec.level < opts.level) {
    return false;
  }

  if (opts.condFuncs) {
    var recCopy = objCopy(rec);
    for (var i = 0; i < opts.condFuncs.length; i++) {
      var pass = opts.condFuncs[i].call(recCopy);
      if (!pass)
        return false;
    }
  } else if (opts.condVm) {
    for (var i = 0; i < opts.condVm.length; i++) {
      var pass = opts.condVm[i].runInNewContext(rec);
      if (!pass)
        return false;
    }
  }

  return true;
}

function emitNextRecord(opts, stylize)
{
  var ofile, ready, minfile, rec;

  for (;;) {
    /*
     * Take a first pass through the input streams to see if we have a
     * record from all of them.  If not, we'll pause any streams for
     * which we do already have a record (to avoid consuming excess
     * memory) and then wait until we have records from the others
     * before emitting the next record.
     *
     * As part of the same pass, we look for the earliest record
     * we have not yet emitted.
     */
    minfile = undefined;
    ready = true;
    for (ofile in streams) {

      if (streams[ofile].stream === null ||
        (!streams[ofile].done && streams[ofile].records.length === 0)) {
        ready = false;
        break;
      }

      if (streams[ofile].records.length > 0 &&
        (minfile === undefined ||
          streams[minfile].records[0].time >
            streams[ofile].records[0].time)) {
        minfile = ofile;
      }
    }

    if (!ready || minfile === undefined) {
      for (ofile in streams) {
        if (!streams[ofile].stream || streams[ofile].done)
          continue;

        if (streams[ofile].records.length > 0) {
          if (!streams[ofile].paused) {
            streams[ofile].paused = true;
            streams[ofile].stream.pause();
          }
        } else if (streams[ofile].paused) {
          streams[ofile].paused = false;
          streams[ofile].stream.resume();
        }
      }

      return;
    }

    /*
     * Emit the next record for 'minfile', and invoke ourselves again to
     * make sure we emit as many records as we can right now.
     */
    rec = streams[minfile].records.shift();
    emitRecord(rec.rec, rec.line, opts, stylize);
  }
}

/**
 * Return a function for the given JS code that returns.
 *
 * If no 'return' in the given javascript snippet, then assume we are a single
 * statement and wrap in 'return (...)'. This is for convenience for short
 * '-c ...' snippets.
 */
function funcWithReturnFromSnippet(js) {
  // auto-"return"
  if (js.indexOf('return') === -1) {
    if (js.substring(js.length - 1) === ';') {
      js = js.substring(0, js.length - 1);
    }
    js = 'return (' + js + ')';
  }

  // Expose level definitions to condition func context
  var varDefs = [];
  Object.keys(upperNameFromLevel).forEach(function (lvl) {
    varDefs.push(format('var %s = %d;',
        upperNameFromLevel[lvl], lvl));
  });
  varDefs = varDefs.join('\n') + '\n';

  return (new Function(varDefs + js));
}

/**
 * Parse the command-line options and arguments into an object.
 *
 *    {
 *      'args': [...]       // arguments
 *      'help': true,       // true if '-h' option given
 *       // etc.
 *    }
 *
 * @return {Object} The parsed options. `.args` is the argument list.
 * @throws {Error} If there is an error parsing argv.
 */
function parseArgv(argv) {
  var parsed = {
    args: [],
    help: false,
    color: null,
    paginate: null,
    outputMode: OM_LONG,
    jsonIndent: 2,
    level: null,
    strict: false,
    timeFormat: TIME_UTC  // one of the TIME_ constants
  };

  // Turn '-iH' into '-i -H', except for argument-accepting options.
  var args = argv.slice(2);  // drop ['node', 'scriptname']
  var newArgs = [];
  var optTakesArg = {'d': true, 'o': true, 'c': true, 'l': true, 'p': true};
  for (var i = 0; i < args.length; i++) {
    if (args[i].charAt(0) === '-' && args[i].charAt(1) !== '-' &&
      args[i].length > 2)
    {
      var splitOpts = args[i].slice(1).split('');
      for (var j = 0; j < splitOpts.length; j++) {
        newArgs.push('-' + splitOpts[j]);
        if (optTakesArg[splitOpts[j]]) {
          var optArg = splitOpts.slice(j+1).join('');
          if (optArg.length) {
            newArgs.push(optArg);
          }
          break;
        }
      }
    } else {
      newArgs.push(args[i]);
    }
  }
  args = newArgs;

  // Expose level definitions to condition vm context
  var condDefines = [];
  Object.keys(upperNameFromLevel).forEach(function (lvl) {
    condDefines.push(
      format('Object.prototype.%s = %s;', upperNameFromLevel[lvl], lvl));
  });
  condDefines = condDefines.join('\n') + '\n';

  var endOfOptions = false;
  while (args.length > 0) {
    var arg = args.shift();
    switch (arg) {
      case '--':
        endOfOptions = true;
        break;
      case '-h': // display help and exit
      case '--help':
        parsed.help = true;
        break;
      case '--version':
        parsed.version = true;
        break;
      case '--strict':
        parsed.strict = true;
        break;
      case '--color':
        parsed.color = true;
        break;
      case '--no-color':
        parsed.color = false;
        break;
      case '--pager':
        parsed.paginate = true;
        break;
      case '--no-pager':
        parsed.paginate = false;
        break;
      case '-o':
      case '--output':
        var name = args.shift();
        var idx = name.lastIndexOf('-');
        if (idx !== -1) {
          var indentation = Number(name.slice(idx+1));
          if (! isNaN(indentation)) {
            parsed.jsonIndent = indentation;
            name = name.slice(0, idx);
          }
        }
        parsed.outputMode = OM_FROM_NAME[name];
        if (parsed.outputMode === undefined) {
          throw new Error('unknown output mode: "'+name+'"');
        }
        break;
      case '-j': // output with JSON.stringify
        parsed.outputMode = OM_JSON;
        break;
      case '-0':
        parsed.outputMode = OM_BUNYAN;
        break;
      case '--time':
        var timeArg = args.shift();
        switch (timeArg) {
        case 'utc':
          parsed.timeFormat = TIME_UTC;
          break
        case undefined:
          throw new Error('missing argument to "--time"');
        default:
          throw new Error(format('invalid time format: "%s"',
            timeArg));
        }
        break;
      case '-l':
      case '--level':
        var levelArg = args.shift();
        var level = +(levelArg);
        if (isNaN(level)) {
          level = +levelFromName[levelArg.toLowerCase()];
        }
        if (isNaN(level)) {
          throw new Error('unknown level value: "'+levelArg+'"');
        }
        parsed.level = level;
        break;
      case '-c':
      case '--condition':
        gUsingConditionOpts = true;
        var condition = args.shift();
        if (Boolean(process.env.BUNYAN_EXEC &&
          process.env.BUNYAN_EXEC === 'vm'))
        {
          parsed.condVm = parsed.condVm || [];
          var scriptName = 'bunyan-condition-'+parsed.condVm.length;
          var code = condDefines + condition;
          var script;
          try {
            script = vm.createScript(code, scriptName);
          } catch (complErr) {
            throw new Error(format('illegal CONDITION code: %s\n'
              + '  CONDITION script:\n'
              + '%s\n'
              + '  Error:\n'
              + '%s',
              complErr, indent(code), indent(complErr.stack)));
          }

          // Ensure this is a reasonably safe CONDITION.
          try {
            script.runInNewContext(minValidRecord);
          } catch (condErr) {
            throw new Error(format(
              /* JSSTYLED */
              'CONDITION code cannot safely filter a minimal Bunyan log record\n'
              + '  CONDITION script:\n'
              + '%s\n'
              + '  Minimal Bunyan log record:\n'
              + '%s\n'
              + '  Filter error:\n'
              + '%s',
              indent(code),
              indent(JSON.stringify(minValidRecord, null, 2)),
              indent(condErr.stack)
              ));
          }
          parsed.condVm.push(script);
        } else  {
          parsed.condFuncs = parsed.condFuncs || [];
          parsed.condFuncs.push(funcWithReturnFromSnippet(condition));
        }
        break;
      default: // arguments
        if (!endOfOptions && arg.length > 0 && arg[0] === '-') {
          throw new Error('unknown option "'+arg+'"');
        }
        parsed.args.push(arg);
        break;
    }
  }
  //TODO: '--' handling and error on a first arg that looks like an option.

  return parsed;
}


function isInteger(s) {
  return (s.search(/^-?[0-9]+$/) == 0);
}


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
// Suggested colors (some are unreadable in common cases):
// - Good: cyan, yellow (limited use), bold, green, magenta, red
// - Bad: blue (not visible on cmd.exe), grey (same color as background on
//   Solarized Dark theme from <https://github.com/altercation/solarized>, see
//   issue #160)
var colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

function stylizeWithColor(str, color) {
  if (!str)
    return '';
  var codes = colors[color];
  if (codes) {
    return '\x33[' + codes[0] + 'm' + str +
           '\x33[' + codes[1] + 'm';
  } else {
    return str;
  }
}

function stylizeWithoutColor(str, color) {
  return str;
}


/**
 * Is this a valid Bunyan log record.
 */
function isValidRecord(rec) {
  if (rec.v == null ||
      rec.level == null ||
      rec.name == null ||
      rec.hostname == null ||
      rec.pid == null ||
      rec.time == null ||
      rec.msg == null) {
    // Not valid Bunyan log.
    return false;
  } else {
    return true;
  }
}
var minValidRecord = {
  v: 0,   //TODO: get this from bunyan.LOG_VERSION
  level: INFO,
  name: 'name',
  hostname: 'hostname',
  pid: 123,
  time: Date.now(),
  msg: 'msg'
};


/**
 * Parses the given log line and either emits it right away (for invalid
 * records) or enqueues it for emitting later when it's the next line to show.
 */
function handleLogLine(file, line, opts, stylize) {
  if (exiting) {
    _selfTrace('warn: handleLogLine called while exiting');
    return;
  }

  currLine = line; // intentionally global

  // Emit non-JSON lines immediately.
  var rec;
  if (!line) {
    if (!opts.strict) emit(line + '\n');
    return;
  } else if (line[0] !== '{') {
    if (!opts.strict) emit(line + '\n');  // not JSON
    return;
  } else {
    try {
      rec = JSON.parse(line);
    } catch (e) {
      if (!opts.strict) emit(line + '\n');
      return;
    }
  }

  if (!isValidRecord(rec)) {
    if (!opts.strict) emit(line + '\n');
    return;
  }

  if (!filterRecord(rec, opts))
    return;

  if (file === null)
    return emitRecord(rec, line, opts, stylize);

  return gotRecord(file, line, rec, opts, stylize);
}

/**
 * Print out a single result, considering input options.
 */
function emitRecord(rec, line, opts, stylize) {
  var short = false;

  switch (opts.outputMode) {
  case OM_SHORT:
    short = true;
    /* jsl:fall-thru */

  case OM_LONG:
    //    [time] LEVEL: name[/comp]/pid on hostname (src): msg* (extras...)
    //        msg*
    //        --
    //        long and multi-line extras
    //        ...
    // If 'msg' is single-line, then it goes in the top line.
    // If 'req', show the request.
    // If 'res', show the response.
    // If 'err' and 'err.stack' then show that.
    if (!isValidRecord(rec)) {
      return emit(line + '\n');
    }

    delete rec.v;

    // Time.
    var time;
    if (!short && opts.timeFormat === TIME_UTC) {
      // Fast default path: We assume the raw `rec.time` is a UTC time
      // in ISO 8601 format (per spec).
      time = '[' + rec.time + ']';
    } else if (opts.timeFormat === TIME_UTC) {
      time = rec.time.substr(11);
    }
    time = stylize(time, 'none');
    delete rec.time;

    var nameStr = rec.name;
    delete rec.name;

    if (rec.component) {
      nameStr += '/' + rec.component;
    }
    delete rec.component;

    if (!short)
      nameStr += '/' + rec.pid;
    delete rec.pid;

    var level = (upperPaddedNameFromLevel[rec.level] || 'LVL' + rec.level);
    if (opts.color) {
      var colorFromLevel = {
        10: 'white',    // TRACE
        20: 'yellow',   // DEBUG
        30: 'cyan',     // INFO
        40: 'magenta',  // WARN
        50: 'red',      // ERROR
        60: 'inverse',  // FATAL
      };
      level = stylize(level, colorFromLevel[rec.level]);
    }
    delete rec.level;

    var src = '';
    if (rec.src && rec.src.file) {
      var s = rec.src;
      if (s.func) {
        src = format(' (%s:%d in %s)', s.file, s.line, s.func);
      } else {
        src = format(' (%s:%d)', s.file, s.line);
      }
      src = stylize(src, 'green');
    }
    delete rec.src;

    var hostname = rec.hostname;
    delete rec.hostname;

    var extras = [];
    var details = [];

    if (rec.req_id) {
      extras.push('req_id=' + rec.req_id);
    }
    delete rec.req_id;

    var onelineMsg;
    if (rec.msg.indexOf('\n') !== -1) {
      onelineMsg = '';
      details.push(indent(stylize(rec.msg, 'cyan')));
    } else {
      onelineMsg = ' ' + stylize(rec.msg, 'cyan');
    }
    delete rec.msg;

    if (rec.req && typeof (rec.req) === 'object') {
      var req = rec.req;
      delete rec.req;
      var headers = req.headers;
      if (!headers) {
        headers = '';
      } else if (typeof (headers) === 'string') {
        headers = '\n' + headers;
      } else if (typeof (headers) === 'object') {
        headers = '\n' + Object.keys(headers).map(function (h) {
          return h + ': ' + headers[h];
        }).join('\n');
      }
      var s = format('%s %s HTTP/%s%s', req.method,
        req.url,
        req.httpVersion || '1.1',
        headers
      );
      delete req.url;
      delete req.method;
      delete req.httpVersion;
      delete req.headers;
      if (req.body) {
        s += '\n\n' + (typeof (req.body) === 'object'
          ? JSON.stringify(req.body, null, 2) : req.body);
        delete req.body;
      }
      if (req.trailers && Object.keys(req.trailers) > 0) {
        s += '\n' + Object.keys(req.trailers).map(function (t) {
          return t + ': ' + req.trailers[t];
        }).join('\n');
      }
      delete req.trailers;
      details.push(indent(s));
      // E.g. for extra 'foo' field on 'req', add 'req.foo' at
      // top-level. This *does* have the potential to stomp on a
      // literal 'req.foo' key.
      Object.keys(req).forEach(function (k) {
        rec['req.' + k] = req[k];
      })
    }

    if (rec.client_req && typeof (rec.client_req) === 'object') {
      var client_req = rec.client_req;
      delete rec.client_req;

      var headers = client_req.headers;
      delete client_req.headers;

      var s = format('%s %s HTTP/%s%s',
        client_req.method,
        client_req.url,
        client_req.httpVersion || '1.1',
        (headers ?
          '\n' + Object.keys(headers).map(
            function (h) {
              return h + ': ' + headers[h];
            }).join('\n') :
          ''));
      delete client_req.method;
      delete client_req.url;
      delete client_req.httpVersion;

      if (client_req.body) {
        s += '\n\n' + (typeof (client_req.body) === 'object' ?
          JSON.stringify(client_req.body, null, 2) :
          client_req.body);
        delete client_req.body;
      }
      // E.g. for extra 'foo' field on 'client_req', add
      // 'client_req.foo' at top-level. This *does* have the potential
      // to stomp on a literal 'client_req.foo' key.
      Object.keys(client_req).forEach(function (k) {
        rec['client_req.' + k] = client_req[k];
      });
      details.push(indent(s));
    }

    function _res(res) {
      var s = '';

      /*
       * Handle `res.header` or `res.headers` as either a string or
       * an object of header key/value pairs. Prefer `res.header` if set,
       * because that's what Bunyan's own `res` serializer specifies,
       * because that's the value in Node.js's core HTTP server response
       * implementation that has all the implicit headers.
       *
       * Note: `res.header` (string) typically includes the 'HTTP/1.1 ...'
       * status line.
       */
      var headerTypes = {string: true, object: true};
      var headers;
      var headersStr = '';
      var headersHaveStatusLine = false;
      if (res.header && headerTypes[typeof (res.header)]) {
        headers = res.header;
        delete res.header;
      } else if (res.headers && headerTypes[typeof (res.headers)]) {
        headers = res.headers;
        delete res.headers;
      }
      if (headers === undefined) {
        /* pass through */
      } else if (typeof (headers) === 'string') {
        headersStr = headers.trimRight(); // Trim the CRLF.
        if (headersStr.slice(0, 5) === 'HTTP/') {
          headersHaveStatusLine = true;
        }
      } else {
        headersStr += Object.keys(headers).map(
          function (h) { return h + ': ' + headers[h]; }).join('\n');
      }

      /*
       * Add a 'HTTP/1.1 ...' status line if the headers didn't already
       * include it.
       */
      if (!headersHaveStatusLine && res.statusCode !== undefined) {
        s += format('HTTP/1.1 %s %s\n', res.statusCode,
          http.STATUS_CODES[res.statusCode]);
      }
      delete res.statusCode;
      s += headersStr;

      if (res.body !== undefined) {
        var body = (typeof (res.body) === 'object'
          ? JSON.stringify(res.body, null, 2) : res.body);
        if (body.length > 0) { s += '\n\n' + body };
        delete res.body;
      } else {
        s = s.trimRight();
      }
      if (res.trailer) {
        s += '\n' + res.trailer;
      }
      delete res.trailer;
      if (s) {
        details.push(indent(s));
      }
      // E.g. for extra 'foo' field on 'res', add 'res.foo' at
      // top-level. This *does* have the potential to stomp on a
      // literal 'res.foo' key.
      Object.keys(res).forEach(function (k) {
        rec['res.' + k] = res[k];
      });
    }

    if (rec.res && typeof (rec.res) === 'object') {
      _res(rec.res);
      delete rec.res;
    }
    if (rec.client_res && typeof (rec.client_res) === 'object') {
      _res(rec.client_res);
      delete rec.client_res;
    }

    if (rec.err && rec.err.stack) {
      var err = rec.err
      if (typeof (err.stack) !== 'string') {
        details.push(indent(err.stack.toString()));
      } else {
        details.push(indent(err.stack));
      }
      delete err.message;
      delete err.name;
      delete err.stack;
      // E.g. for extra 'foo' field on 'err', add 'err.foo' at
      // top-level. This *does* have the potential to stomp on a
      // literal 'err.foo' key.
      Object.keys(err).forEach(function (k) {
        rec['err.' + k] = err[k];
      })
      delete rec.err;
    }

    var leftover = Object.keys(rec);
    for (var i = 0; i < leftover.length; i++) {
      var key = leftover[i];
      var value = rec[key];
      var stringified = false;
      if (typeof (value) !== 'string') {
        value = JSON.stringify(value, null, 2);
        stringified = true;
      }
      if (value.indexOf('\n') !== -1 || value.length > 50) {
        details.push(indent(key + ': ' + value));
      } else if (!stringified && (value.indexOf(' ') != -1 ||
        value.length === 0))
      {
        extras.push(key + '=' + JSON.stringify(value));
      } else {
        extras.push(key + '=' + value);
      }
    }

    extras = stylize(
      (extras.length ? ' (' + extras.join(', ') + ')' : ''), 'none');
    details = stylize(
      (details.length ? details.join('\n    --\n') + '\n' : ''), 'none');
    if (!short)
      emit(format('%s %s: %s on %s%s:%s%s\n%s',
        time,
        level,
        nameStr,
        hostname || '<no-hostname>',
        src,
        onelineMsg,
        extras,
        details));
    else
      emit(format('%s %s %s:%s%s\n%s',
        time,
        level,
        nameStr,
        onelineMsg,
        extras,
        details));
    break;

  case OM_INSPECT:
    emit(util.inspect(rec, false, Infinity, true) + '\n');
    break;

  case OM_BUNYAN:
    emit(JSON.stringify(rec, null, 0) + '\n');
    break;

  case OM_JSON:
    emit(JSON.stringify(rec, null, opts.jsonIndent) + '\n');
    break;

  case OM_SIMPLE:
    /* JSSTYLED */
    // <http://logging.apache.org/log4j/1.2/apidocs/org/apache/log4j/SimpleLayout.html>
    if (!isValidRecord(rec)) {
      return emit(line + '\n');
    }
    emit(format('%s - %s\n',
      upperNameFromLevel[rec.level] || 'LVL' + rec.level,
      rec.msg));
    break;
  default:
    throw new Error('unknown output mode: '+opts.outputMode);
  }
}


function emit(s) {
  try {
    stdout.write(s);
  } catch (writeErr) {
    _selfTrace('exception from stdout.write:', writeErr)
    // Handle any exceptions in stdout writing in `stdout.on('error', ...)`.
  }
}


/**
 * Process all input from stdin.
 *
 * @params opts {Object} Bunyan options object.
 * @param stylize {Function} Output stylize function to use.
 * @param callback {Function} `function ()`
 */
function processStdin(opts, stylize, callback) {
  var leftover = '';  // Left-over partial line from last chunk.
  var stdin = process.stdin;
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', function (chunk) {
    var lines = chunk.split(/\r\n|\n/);
    var length = lines.length;
    if (length === 1) {
      leftover += lines[0];
      return;
    }

    if (length > 1) {
      handleLogLine(null, leftover + lines[0], opts, stylize);
    }
    leftover = lines.pop();
    length -= 1;
    for (var i = 1; i < length; i++) {
      handleLogLine(null, lines[i], opts, stylize);
    }
  });
  stdin.on('end', function () {
    if (leftover) {
      handleLogLine(null, leftover, opts, stylize);
      leftover = '';
    }
    callback();
  });
}


/**
 * Process all input from the given log file.
 *
 * @param file {String} Log file path to process.
 * @params opts {Object} Bunyan options object.
 * @param stylize {Function} Output stylize function to use.
 * @param callback {Function} `function ()`
 */
function processFile(file, opts, stylize, callback) {
  var stream = fs.createReadStream(file);
  if (/\.gz$/.test(file)) {
    stream = stream.pipe(createGunzip());
  }
  // Manually decode streams - lazy load here as per node/lib/fs.js
  var decoder = new StringDecoder('utf8');

  streams[file].stream = stream;

  stream.on('error', function (err) {
    streams[file].done = true;
    callback(err);
  });

  var leftover = '';  // Left-over partial line from last chunk.
  stream.on('data', function (data) {
    if (exiting) {
      _selfTrace('stop reading file "%s" because exiting', file);
      stream.destroy();
      return;
    }

    var chunk = decoder.write(data);
    if (!chunk.length) {
      return;
    }
    var lines = chunk.split(/\r\n|\n/);
    var length = lines.length;
    if (length === 1) {
      leftover += lines[0];
      return;
    }

    if (length > 1) {
      handleLogLine(file, leftover + lines[0], opts, stylize);
    }
    leftover = lines.pop();
    length -= 1;
    for (var i = 1; i < length; i++) {
      handleLogLine(file, lines[i], opts, stylize);
    }
  });

  stream.on('end', function () {
    streams[file].done = true;
    if (leftover) {
      handleLogLine(file, leftover, opts, stylize);
      leftover = '';
    } else {
      emitNextRecord(opts, stylize);
    }
    callback();
  });
}


/**
 * From node async module.
 */
/* BEGIN JSSTYLED */
function asyncForEach(arr, iterator, callback) {
  callback = callback || function () {};
  if (!arr.length) {
    return callback();
  }
  var completed = 0;
  arr.forEach(function (x) {
    iterator(x, function (err) {
      if (err) {
        callback(err);
        callback = function () {};
      }
      else {
        completed += 1;
        if (completed === arr.length) {
          callback();
        }
      }
    });
  });
};
/* END JSSTYLED */



/**
 * Cleanup and exit properly.
 *
 * Warning: this doesn't necessarily stop processing, i.e. process exit
 * might be delayed. It is up to the caller to ensure that no subsequent
 * bunyan processing is done after calling this.
 *
 * @param code {Number} exit code.
 * @param signal {String} Optional signal name, if this was exitting because
 *    of a signal.
 */
function cleanupAndExit(code, signal) {
  // Guard one call.
  if (exiting) {
    return;
  }
  exiting = true;
  _selfTrace('cleanupAndExit(%s, %s)', code, signal);

  // Clear possibly interrupted ANSI code (issue #59).
  if (usingAnsiCodes) {
    stdout.write('\x33[0m');
  }

  if (pager) {
    // Let pager know that output is done, then wait for pager to exit.
    pager.removeListener('exit', onPrematurePagerExit);
    pager.on('exit', function onPagerExit(pagerCode) {
      _selfTrace('pager exit -> process.exit(%s)', pagerCode || code);
      process.exit(pagerCode || code);
    });
    stdout.end();
  } else if (code) {
    // Non-zero exit: Something is wrong. We are very likely still
    // processing log records -- i.e. we have open handles -- so we need
    // a hard stop (aka `process.exit`).
    _selfTrace('process.exit(%s)', code);
    process.exit(code);
  } else {
    // Zero exit: This should be a "normal" exit, for which we want to
    // flush stdout/stderr.
    process.exit(0);
  }
}



//---- mainline

process.on('SIGINT', function () { cleanupAndExit(1, 'SIGINT'); });
process.on('SIGQUIT', function () { cleanupAndExit(1, 'SIGQUIT'); });
process.on('SIGTERM', function () { cleanupAndExit(1, 'SIGTERM'); });
process.on('SIGHUP', function () { cleanupAndExit(1, 'SIGHUP'); });

process.on('uncaughtException', function (err) {
  function _indent(s) {
    var lines = s.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      lines[i] = '*     ' + lines[i];
    }
    return lines.join('\n');
  }

  var title = encodeURIComponent(format(
    'Bunyan %s crashed: %s', getVersion(), String(err)));
  var e = console.error;
  e('```');
  e('* The Bunyan CLI crashed!');
  e('*');
  if (err.name === 'ReferenceError' && gUsingConditionOpts) {
    /* BEGIN JSSTYLED */
    e('* This crash was due to a "ReferenceError", which is often the result of given');
    e('* `-c CONDITION` code that doesn\'t guard against undefined values. If that is');
    /* END JSSTYLED */
    e('* not the problem:');
    e('*');
  }
  e('* Please report this issue and include the details below:');
  e('*');
  e('*    https://github.com/trentm/node-bunyan/issues/new?title=%s', title);
  e('*');
  e('* * *');
  e('* platform:', process.platform);
  e('* node version:', process.version);
  e('* bunyan version:', getVersion());
  e('* argv: %j', process.argv);
  e('* log line: %j', currLine);
  e('* stack:');
  e(_indent(err.stack));
  e('```');
  process.exit(1);
});


// Early termination of the pager: just stop.
function onPrematurePagerExit(pagerCode) {
  _selfTrace('premature pager exit');
  // 'pager' and 'stdout' are intentionally global.
  pager = null;
  stdout.end()
  stdout = process.stdout;
  cleanupAndExit(pagerCode);
}


function main(argv) {
  try {
    var opts = parseArgv(argv);
  } catch (e) {
    warn('bunyan: error: %s', e.message);
    cleanupAndExit(1);
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.version) {
    console.log('bunyan ' + getVersion());
    return;
  }
  if (opts.color === null) {
    if (process.env.BUNYAN_NO_COLOR &&
        process.env.BUNYAN_NO_COLOR.length > 0) {
      opts.color = false;
    } else {
      opts.color = process.stdout.isTTY;
    }
  }
  usingAnsiCodes = opts.color; // intentionally global
  var stylize = (opts.color ? stylizeWithColor : stylizeWithoutColor);

  // Pager.
  var paginate = (
    process.stdout.isTTY &&
    process.stdin.isTTY &&
    opts.args.length > 0 && // Don't page if no file args to process.
    process.platform !== 'win32' &&
    (nodeVer[0] > 0 || nodeVer[1] >= 8) &&
    (opts.paginate === true ||
      (opts.paginate !== false &&
        (!process.env.BUNYAN_NO_PAGER ||
          process.env.BUNYAN_NO_PAGER.length === 0))));
  if (paginate) {
    var pagerCmd = process.env.PAGER || 'less';
    /* JSSTYLED */
    assert.ok(pagerCmd.indexOf('"') === -1 && pagerCmd.indexOf("'") === -1,
      'cannot parse PAGER quotes yet');
    var argv = pagerCmd.split(/\s+/g);
    var env = objCopy(process.env);
    if (env.LESS === undefined) {
      // git's default is LESS=FRSX. I don't like the 'S' here because
      // lines are *typically* wide with bunyan output and scrolling
      // horizontally is a royal pain. Note a bug in Mac's `less -F`,
      // such that SIGWINCH can kill it. If that rears too much then
      // I'll remove 'F' from here.
      env.LESS = 'FRX';
    }
    _selfTrace('pager: argv=%j, env.LESS=%j', argv, env.LESS);
    // `pager` and `stdout` intentionally global.
    pager = spawn(argv[0], argv.slice(1),
      // Share the stderr handle to have error output come
      // straight through. Only supported in v0.8+.
      {env: env, stdio: ['pipe', 1, 2]});
    stdout = pager.stdin;
    pager.on('exit', onPrematurePagerExit);
  }

  // Stdout error handling. (Couldn't setup until `stdout` was determined.)
  stdout.on('error', function (err) {
    _selfTrace('stdout error event: %s, exiting=%s', err, exiting);
    if (exiting) {
      return;
    } else if (err.code === 'EPIPE') {
      cleanupAndExit(0);
    } else {
      warn('bunyan: error on output stream: %s', err);
      cleanupAndExit(1);
    }
  });

  var retval = 0;
  if (opts.args.length > 0) {
    var files = opts.args;
    files.forEach(function (file) {
      streams[file] = { stream: null, records: [], done: false }
    });
    asyncForEach(files,
      function (file, next) {
        processFile(file, opts, stylize, function (err) {
          if (err) {
            warn('bunyan: %s', err.message);
            retval += 1;
          }
          next();
        });
      },
      function (err) {
        if (err) {
          warn('bunyan: unexpected error: %s', err.stack || err);
          cleanupAndExit(1);
        } else {
          cleanupAndExit(retval);
        }
      }
    );
  } else {
    processStdin(opts, stylize, function () {
      cleanupAndExit(retval);
    });
  }
}

main(process.argv);
