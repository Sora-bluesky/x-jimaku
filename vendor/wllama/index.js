// .wllama-build/source/src/glue/messages.ts
var GLUE_VERSION = 1;
var GLUE_MESSAGE_PROTOTYPES = {
  "erro_evt": {
    "name": "erro_evt",
    "structName": "glue_msg_error",
    "className": "GlueMsgError",
    "fields": [
      {
        "type": "str",
        "name": "message",
        "isNullable": false
      }
    ]
  },
  "load_req": {
    "name": "load_req",
    "structName": "glue_msg_load_req",
    "className": "GlueMsgLoadReq",
    "fields": [
      {
        "type": "arr_str",
        "name": "model_paths",
        "isNullable": false
      },
      {
        "type": "str",
        "name": "mmproj_path",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "n_ctx_auto",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "use_mmap",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "use_mlock",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_gpu_layers",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_ctx",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_threads",
        "isNullable": false
      },
      {
        "type": "str",
        "name": "model_alias",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "log_level",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "embeddings",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "offload_kqv",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "n_batch",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "n_ubatch",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "n_parallel",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "pooling_type",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "rope_scaling_type",
        "isNullable": true
      },
      {
        "type": "float",
        "name": "rope_freq_base",
        "isNullable": true
      },
      {
        "type": "float",
        "name": "rope_freq_scale",
        "isNullable": true
      },
      {
        "type": "float",
        "name": "yarn_ext_factor",
        "isNullable": true
      },
      {
        "type": "float",
        "name": "yarn_attn_factor",
        "isNullable": true
      },
      {
        "type": "float",
        "name": "yarn_beta_fast",
        "isNullable": true
      },
      {
        "type": "float",
        "name": "yarn_beta_slow",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "yarn_orig_ctx",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "cache_type_k",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "cache_type_v",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "kv_unified",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "flash_attn",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "swa_full",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "n_ctx_checkpoints",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "checkpoint_min_step",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "chat_template",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "jinja",
        "isNullable": true
      },
      {
        "type": "arr_str",
        "name": "default_template_kwargs_keys",
        "isNullable": true
      },
      {
        "type": "arr_str",
        "name": "default_template_kwargs_vals",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "reasoning",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "image_min_tokens",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "image_max_tokens",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "warmup",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "no_kv_offload",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "mmproj_offload",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "cont_batching",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "n_keep",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "ctx_shift",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "cache_idle_slots",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "n_cache_reuse",
        "isNullable": true
      },
      {
        "type": "arr_str",
        "name": "lora_paths",
        "isNullable": true
      },
      {
        "type": "arr_float",
        "name": "lora_scales",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "lora_init_without_apply",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "spec_draft_model",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "spec_draft_ngl",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "spec_draft_n_max",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "spec_draft_n_min",
        "isNullable": true
      },
      {
        "type": "float",
        "name": "spec_draft_p_min",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "spec_draft_threads",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "spec_draft_threads_batch",
        "isNullable": true
      },
      {
        "type": "arr_str",
        "name": "kv_overrides_keys",
        "isNullable": true
      },
      {
        "type": "arr_str",
        "name": "kv_overrides_vals",
        "isNullable": true
      },
      {
        "type": "int",
        "name": "reasoning_budget_tokens",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "reasoning_budget_message",
        "isNullable": true
      },
      {
        "type": "str",
        "name": "reasoning_format",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "skip_chat_parsing",
        "isNullable": true
      },
      {
        "type": "bool",
        "name": "prefill_assistant",
        "isNullable": true
      }
    ]
  },
  "load_res": {
    "name": "load_res",
    "structName": "glue_msg_load_res",
    "className": "GlueMsgLoadRes",
    "fields": [
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_ctx",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_batch",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_ubatch",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_vocab",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_ctx_train",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_embd",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "n_layer",
        "isNullable": false
      },
      {
        "type": "arr_str",
        "name": "metadata_key",
        "isNullable": false
      },
      {
        "type": "arr_str",
        "name": "metadata_val",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "token_bos",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "token_eos",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "token_eot",
        "isNullable": false
      },
      {
        "type": "arr_int",
        "name": "list_tokens_eog",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "add_bos_token",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "add_eos_token",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "has_encoder",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "token_decoder_start",
        "isNullable": false
      },
      {
        "type": "str",
        "name": "media_marker",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "has_image_input",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "has_audio_input",
        "isNullable": false
      }
    ]
  },
  "cmpl_req": {
    "name": "cmpl_req",
    "structName": "glue_msg_completion_req",
    "className": "GlueMsgCompletionReq",
    "fields": [
      {
        "type": "bool",
        "name": "is_chat",
        "isNullable": false
      },
      {
        "type": "str",
        "name": "data_json",
        "isNullable": false
      },
      {
        "type": "arr_raw",
        "name": "files",
        "isNullable": false
      }
    ]
  },
  "cmpl_res": {
    "name": "cmpl_res",
    "structName": "glue_msg_completion_res",
    "className": "GlueMsgCompletionRes",
    "fields": [
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "req_id",
        "isNullable": false
      }
    ]
  },
  "embd_req": {
    "name": "embd_req",
    "structName": "glue_msg_embedding_req",
    "className": "GlueMsgEmbeddingReq",
    "fields": [
      {
        "type": "str",
        "name": "data_json",
        "isNullable": false
      },
      {
        "type": "arr_raw",
        "name": "files",
        "isNullable": false
      }
    ]
  },
  "embd_res": {
    "name": "embd_res",
    "structName": "glue_msg_embedding_res",
    "className": "GlueMsgEmbeddingRes",
    "fields": [
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      },
      {
        "type": "str",
        "name": "message",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "req_id",
        "isNullable": false
      }
    ]
  },
  "rrnk_req": {
    "name": "rrnk_req",
    "structName": "glue_msg_rerank_req",
    "className": "GlueMsgRerankReq",
    "fields": [
      {
        "type": "str",
        "name": "data_json",
        "isNullable": false
      }
    ]
  },
  "rrnk_res": {
    "name": "rrnk_res",
    "structName": "glue_msg_rerank_res",
    "className": "GlueMsgRerankRes",
    "fields": [
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "req_id",
        "isNullable": false
      }
    ]
  },
  "sys1_req": {
    "name": "sys1_req",
    "structName": "glue_msg_systemone_req",
    "className": "GlueMsgSystemoneReq",
    "fields": [
      {
        "type": "str",
        "name": "data_json",
        "isNullable": false
      }
    ]
  },
  "sys1_res": {
    "name": "sys1_res",
    "structName": "glue_msg_systemone_res",
    "className": "GlueMsgSystemoneRes",
    "fields": [
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      },
      {
        "type": "int",
        "name": "req_id",
        "isNullable": false
      }
    ]
  },
  "gres_req": {
    "name": "gres_req",
    "structName": "glue_msg_get_result_req",
    "className": "GlueMsgGetResultReq",
    "fields": [
      {
        "type": "int",
        "name": "req_id",
        "isNullable": false
      }
    ]
  },
  "gres_res": {
    "name": "gres_res",
    "structName": "glue_msg_get_result_res",
    "className": "GlueMsgGetResultRes",
    "fields": [
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "has_more",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "is_error",
        "isNullable": false
      },
      {
        "type": "str",
        "name": "data_json",
        "isNullable": false
      }
    ]
  },
  "cncl_req": {
    "name": "cncl_req",
    "structName": "glue_msg_cancel_req",
    "className": "GlueMsgCancelReq",
    "fields": [
      {
        "type": "int",
        "name": "req_id",
        "isNullable": false
      }
    ]
  },
  "cncl_res": {
    "name": "cncl_res",
    "structName": "glue_msg_cancel_res",
    "className": "GlueMsgCancelRes",
    "fields": [
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      }
    ]
  },
  "tbop_req": {
    "name": "tbop_req",
    "structName": "glue_msg_test_backend_ops_req",
    "className": "GlueMsgTestBackendOpsReq",
    "fields": [
      {
        "type": "arr_str",
        "name": "args",
        "isNullable": false
      }
    ]
  },
  "tbop_res": {
    "name": "tbop_res",
    "structName": "glue_msg_test_backend_ops_res",
    "className": "GlueMsgTestBackendOpsRes",
    "fields": [
      {
        "type": "int",
        "name": "retcode",
        "isNullable": false
      },
      {
        "type": "bool",
        "name": "success",
        "isNullable": false
      }
    ]
  }
};

// .wllama-build/source/src/glue/glue.ts
var GLUE_MAGIC = new Uint8Array([71, 76, 85, 69]);
var GLUE_DTYPE_NULL = 0;
var GLUE_DTYPE_BOOL = 1;
var GLUE_DTYPE_INT = 2;
var GLUE_DTYPE_FLOAT = 3;
var GLUE_DTYPE_STRING = 4;
var GLUE_DTYPE_RAW = 5;
var GLUE_DTYPE_ARRAY_BOOL = 6;
var GLUE_DTYPE_ARRAY_INT = 7;
var GLUE_DTYPE_ARRAY_FLOAT = 8;
var GLUE_DTYPE_ARRAY_STRING = 9;
var GLUE_DTYPE_ARRAY_RAW = 10;
var TYPE_MAP = {
  str: GLUE_DTYPE_STRING,
  int: GLUE_DTYPE_INT,
  float: GLUE_DTYPE_FLOAT,
  bool: GLUE_DTYPE_BOOL,
  raw: GLUE_DTYPE_RAW,
  arr_str: GLUE_DTYPE_ARRAY_STRING,
  arr_int: GLUE_DTYPE_ARRAY_INT,
  arr_float: GLUE_DTYPE_ARRAY_FLOAT,
  arr_bool: GLUE_DTYPE_ARRAY_BOOL,
  arr_raw: GLUE_DTYPE_ARRAY_RAW,
  null: GLUE_DTYPE_NULL
};
function glueDeserialize(buf) {
  let offset = 0;
  const view = new DataView(buf.buffer);
  const readUint32 = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  const readInt32 = () => {
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const readFloat = () => {
    const value = view.getFloat32(offset, true);
    offset += 4;
    return value;
  };
  const readBool = () => {
    return readUint32() !== 0;
  };
  const readString = (customLen) => {
    const length = customLen ?? readUint32();
    const value = new TextDecoder().decode(buf.slice(offset, offset + length));
    offset += length;
    return value;
  };
  const readRaw = () => {
    const length = readUint32();
    const value = buf.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const readArray = (readItem) => {
    const length = readUint32();
    const value = new Array(length);
    for (let i = 0; i < length; i++) {
      value[i] = readItem();
    }
    return value;
  };
  const readNull = () => null;
  const readField = (field) => {
    switch (field.type) {
      case "str":
        return readString();
      case "int":
        return readInt32();
      case "float":
        return readFloat();
      case "bool":
        return readBool();
      case "raw":
        return readRaw();
      case "arr_str":
        return readArray(readString);
      case "arr_int":
        return readArray(readInt32);
      case "arr_float":
        return readArray(readFloat);
      case "arr_bool":
        return readArray(readBool);
      case "arr_raw":
        return readArray(readRaw);
      case "null":
        return readNull();
    }
  };
  const magicValid = buf[0] === GLUE_MAGIC[0] && buf[1] === GLUE_MAGIC[1] && buf[2] === GLUE_MAGIC[2] && buf[3] === GLUE_MAGIC[3];
  offset += 4;
  if (!magicValid) {
    throw new Error("Invalid magic number");
  }
  const version = readUint32();
  if (version !== GLUE_VERSION) {
    throw new Error("Invalid version number");
  }
  const name = readString(8);
  const msgProto = GLUE_MESSAGE_PROTOTYPES[name];
  if (!msgProto) {
    throw new Error(`Unknown message name: ${name}`);
  }
  const output = { _name: name };
  for (const field of msgProto.fields) {
    const readType = readUint32();
    if (readType === GLUE_DTYPE_NULL) {
      if (!field.isNullable) {
        throw new Error(
          `${name}: Expect field ${field.name} to be non-nullable`
        );
      }
      output[field.name] = null;
      continue;
    }
    if (readType !== TYPE_MAP[field.type]) {
      throw new Error(
        `${name}: Expect field ${field.name} to have type ${field.type}`
      );
    }
    output[field.name] = readField(field);
  }
  return output;
}
function glueSerialize(msg) {
  const msgProto = GLUE_MESSAGE_PROTOTYPES[msg._name];
  if (!msgProto) {
    throw new Error(`Unknown message name: ${msg._name}`);
  }
  const bufs = [];
  const writeUint32 = (value) => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, value, true);
    bufs.push(new Uint8Array(buf));
  };
  const writeInt32 = (value) => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, value, true);
    bufs.push(new Uint8Array(buf));
  };
  const writeFloat = (value) => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, true);
    bufs.push(new Uint8Array(buf));
  };
  const writeBool = (value) => {
    writeUint32(value ? 1 : 0);
  };
  const writeString = (value) => {
    const utf8 = new TextEncoder().encode(value);
    writeUint32(utf8.byteLength);
    bufs.push(utf8);
  };
  const writeRaw = (value) => {
    writeUint32(value.byteLength);
    bufs.push(value);
  };
  const writeArray = (value, writeItem) => {
    writeUint32(value.length);
    for (const item of value) {
      writeItem(item);
    }
  };
  const writeNull = () => {
  };
  bufs.push(GLUE_MAGIC);
  writeUint32(GLUE_VERSION);
  {
    const utf8 = new TextEncoder().encode(msg._name);
    bufs.push(utf8);
  }
  for (const field of msgProto.fields) {
    const val = msg[field.name];
    if (!field.isNullable && (val === null || val === void 0)) {
      throw new Error(
        `${msg._name}: Expect field ${field.name} to be non-nullable`
      );
    }
    if (val === null || val === void 0) {
      writeUint32(GLUE_DTYPE_NULL);
      continue;
    }
    writeUint32(TYPE_MAP[field.type]);
    switch (field.type) {
      case "str":
        writeString(val);
        break;
      case "int":
        writeInt32(val);
        break;
      case "float":
        writeFloat(val);
        break;
      case "bool":
        writeBool(val);
        break;
      case "raw":
        writeRaw(val);
        break;
      case "arr_str":
        writeArray(val, writeString);
        break;
      case "arr_int":
        writeArray(val, writeInt32);
        break;
      case "arr_float":
        writeArray(val, writeFloat);
        break;
      case "arr_bool":
        writeArray(val, writeBool);
        break;
      case "arr_raw":
        writeArray(val, writeRaw);
        break;
      case "null":
        writeNull();
        break;
    }
  }
  const totalLength = bufs.reduce((acc, buf) => acc + buf.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of bufs) {
    output.set(buf, offset);
    offset += buf.byteLength;
  }
  return output;
}

// .wllama-build/source/src/utils.ts
var textDecoder = new TextDecoder();
var URL_PARTS_REGEX = /-(\d{5})-of-(\d{5})\.gguf(?:\?.*)?$/;
var parseShardNumber = (fnameOrUrl) => {
  const matches = fnameOrUrl.match(URL_PARTS_REGEX);
  if (!matches) {
    return {
      baseURL: fnameOrUrl,
      current: 1,
      total: 1
    };
  } else {
    return {
      baseURL: fnameOrUrl.replace(URL_PARTS_REGEX, ""),
      current: parseInt(matches[1]),
      total: parseInt(matches[2])
    };
  }
};
var sortFileByShard = (blobs) => {
  const isFiles = blobs.every((b) => !!b.name);
  if (isFiles && blobs.length > 1) {
    const files = blobs;
    files.sort((a, b) => {
      const infoA = parseShardNumber(a.name);
      const infoB = parseShardNumber(b.name);
      return infoA.current - infoB.current;
    });
  }
};
var isMmproj = async (blob) => {
  const META_NAME = "general.architecture";
  const META_VAL = "clip";
  const tmp = blob.slice(0, 128 * 1024);
  const header = await tmp.arrayBuffer();
  const buf = new Uint8Array(header);
  const nameBytes = new TextEncoder().encode(META_NAME);
  const valBytes = new TextEncoder().encode(META_VAL);
  let offset = -1;
  outer: for (let i = 0; i <= buf.length - nameBytes.length; i++) {
    for (let j = 0; j < nameBytes.length; j++) {
      if (buf[i + j] !== nameBytes[j]) continue outer;
    }
    offset = i;
    break;
  }
  if (offset === -1) return false;
  if (offset + 8 * 4 + 4 > buf.length) return false;
  const view = new DataView(header);
  const valLen = view.getBigUint64(offset + 8 * 3, true);
  if (valLen !== 4n) return false;
  for (let i = 0; i < valBytes.length; i++) {
    if (buf[offset + 8 * 4 + i] !== valBytes[i]) return false;
  }
  return true;
};
var absoluteUrl = (relativePath) => typeof document === "undefined" ? new URL(relativePath, self.location.href).href : new URL(relativePath, document.baseURI).href;
var padDigits = (number, digits) => {
  return Array(Math.max(digits - String(number).length + 1, 0)).join("0") + number;
};
var sumArr = (arr) => arr.reduce((prev, curr) => prev + curr, 0);
var isString = (value) => !!value?.startsWith;
var MMPROJ_FILE_NAME = "mmproj.gguf";
var prepareBlobs = async (blobsInp) => {
  const blobs = [];
  let blobMmproj = null;
  for (const blob of blobsInp) {
    if (await isMmproj(blob)) {
      blobMmproj = blob;
    } else {
      blobs.push(blob);
    }
  }
  sortFileByShard(blobs);
  const result = blobs.map((blob, i) => ({
    blob,
    name: `model-${padDigits(i + 1, 5)}-of-${padDigits(blobs.length, 5)}.gguf`
  }));
  if (blobMmproj) {
    result.push({
      blob: blobMmproj,
      name: MMPROJ_FILE_NAME
    });
  }
  return {
    llm: result.filter((f) => f.name !== MMPROJ_FILE_NAME),
    mmproj: blobMmproj ? { blob: blobMmproj, name: MMPROJ_FILE_NAME } : null,
    all: result
  };
};
var isSupportMultiThread = () => (async (e) => {
  try {
    return "undefined" != typeof MessageChannel && new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)), WebAssembly.validate(e);
  } catch (e2) {
    return false;
  }
})(
  new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    4,
    1,
    96,
    0,
    0,
    3,
    2,
    1,
    0,
    5,
    4,
    1,
    3,
    1,
    1,
    10,
    11,
    1,
    9,
    0,
    65,
    0,
    254,
    16,
    2,
    0,
    26,
    11
  ])
);
var isSupportExceptions = async () => WebAssembly.validate(
  new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    4,
    1,
    96,
    0,
    0,
    3,
    2,
    1,
    0,
    10,
    8,
    1,
    6,
    0,
    6,
    64,
    25,
    11,
    11
  ])
);
var isSupportSIMD = async () => WebAssembly.validate(
  new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    1,
    5,
    1,
    96,
    0,
    1,
    123,
    3,
    2,
    1,
    0,
    10,
    10,
    1,
    8,
    0,
    65,
    0,
    253,
    15,
    253,
    98,
    11
  ])
);
var isSupportJSPI = () => {
  return !!WebAssembly.Suspending;
};
var isSupportWebGPU = () => {
  return !!navigator.gpu;
};
var isSupportMem64 = () => {
  try {
    new WebAssembly.Memory({
      address: "i64",
      initial: 1n
      // 1 page (64 KiB)
    });
    return true;
  } catch {
    return false;
  }
};
var checkEnvironmentCompatible = async () => {
  if (!await isSupportExceptions()) {
    throw new Error("WebAssembly runtime does not support exception handling");
  }
  if (!await isSupportSIMD()) {
    throw new Error("WebAssembly runtime does not support SIMD");
  }
};
var isFirefox = () => {
  return !!navigator.userAgent.match(/Firefox\/([0-9\.]+)(?:\s|$)/);
};
var GGUF_FILE_REGEX = /^.*\.gguf(?:\?.*)?$/;
var isValidGgufFile = (path) => {
  return GGUF_FILE_REGEX.test(path);
};
var isSafariMobile = () => {
  return !!navigator.userAgent.match(/Version\/([0-9\._]+).*Mobile.*Safari.*/);
};
var cbToAsyncIter = (fn) => (...args) => {
  let values = [];
  let resolve;
  let reject;
  values.push(
    new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    })
  );
  fn(...args, (val, done, err) => {
    if (err) {
      reject(err);
      return;
    }
    resolve([val, done]);
    values.push(
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      })
    );
  });
  return async function* () {
    let val;
    for (let i = 0, done = false; !done; i++) {
      [val, done] = await values[i];
      delete values[i];
      if (val !== void 0) yield val;
    }
  }();
};
var canUseAsyncFileRead = (compat) => isSupportJSPI() || compat;
var needCompat = () => !isSupportJSPI() || !isSupportMem64();

// .wllama-build/source/src/worker.ts
var FILE_READ_REQ_EVENT = "fs.read_req";
var ProxyToWorker = class {
  resources;
  logger;
  suppressNativeLog;
  taskQueue = [];
  taskId = 1;
  resultQueue = [];
  busy = false;
  // is the work loop is running?
  worker;
  multiThread;
  nbThread;
  useAsyncFile;
  fileBlobs = /* @__PURE__ */ new Map();
  // filename -> Blob for async reads
  constructor(resources, nbThread, suppressNativeLog, logger) {
    this.resources = resources;
    this.nbThread = nbThread;
    this.multiThread = nbThread > 0;
    this.logger = logger;
    this.suppressNativeLog = suppressNativeLog;
    this.useAsyncFile = canUseAsyncFileRead(resources.compat);
  }
  async moduleInit(ggufFiles) {
    this.worker = new Worker(new URL("/wllama/wllama-worker.js", self.location.origin), { type: "module" });
    this.worker.onmessage = this.onRecvMsg.bind(this);
    this.worker.onerror = this.logger.error;
    const res = await this.pushTask({
      verb: "module.init",
      args: [
        null,
        this.useAsyncFile
      ],
      callbackId: this.taskId++
    });
    const nativeFiles = [];
    for (const file of ggufFiles) {
      const needAllocBuffer = !this.useAsyncFile;
      const id = await this.fileAlloc(
        file.name,
        file.blob.size,
        needAllocBuffer
      );
      nativeFiles.push({ id, ...file });
      if (this.useAsyncFile) {
        this.fileBlobs.set(file.name, file.blob);
      }
    }
    if (!this.useAsyncFile) {
      await Promise.all(
        nativeFiles.map((file) => {
          return this.fileWrite(file.id, file.blob);
        })
      );
    }
    return res;
  }
  async wllamaStart() {
    const result = await this.pushTask({
      verb: "wllama.start",
      args: [],
      callbackId: this.taskId++
    });
    const parsedResult = this.parseResult(result);
    return parsedResult;
  }
  async wllamaAction(name, body) {
    const encodedMsg = glueSerialize(body);
    const result = await this.pushTask({
      verb: "wllama.action",
      args: [name, encodedMsg],
      callbackId: this.taskId++
    });
    const parsedResult = glueDeserialize(result);
    return parsedResult;
  }
  async wllamaExit() {
    if (this.worker) {
      this.worker.terminate();
    }
  }
  async wllamaDebug() {
    const result = await this.pushTask({
      verb: "wllama.debug",
      args: [],
      callbackId: this.taskId++
    });
    return JSON.parse(result);
  }
  ///////////////////////////////////////
  /**
   * Allocate a new file in heapfs
   * @returns fileId, to be used by fileWrite()
   */
  async fileAlloc(fileName, size, allocBuffer) {
    const result = await this.pushTask({
      verb: "fs.alloc",
      args: [fileName, size, allocBuffer],
      callbackId: this.taskId++
    });
    return result.fileId;
  }
  /**
   * Write a Blob to heapfs
   */
  async fileWrite(fileId, blob) {
    const reader = blob.stream().getReader();
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const size = value.byteLength;
      await this.pushTask(
        {
          verb: "fs.write",
          args: [fileId, value, offset],
          callbackId: this.taskId++
        },
        // @ts-ignore Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'
        [value.buffer]
      );
      offset += size;
    }
  }
  async fileReadResponse(name, offset, size) {
    try {
      const blob = this.fileBlobs.get(name);
      if (!blob) {
        throw new Error(`blob not found for name="${name}"`);
      }
      const chunk = blob.slice(offset, offset + size);
      const buffer = await chunk.arrayBuffer();
      this.worker.postMessage(
        { verb: "fs.read_res", args: [buffer] },
        { transfer: [buffer] }
      );
    } catch (err) {
      this.logger.error("fileReadResponse failed, terminating worker:", err);
      this.worker?.terminate();
      this.worker = void 0;
      this.abort(`File read failed: ${err}`, err.stack || "");
    }
  }
  /**
   * Parse JSON result returned by cpp code.
   * Throw new Error if "__exception" is present in the response
   *
   * TODO: get rid of this function once everything is migrated to Glue
   */
  parseResult(result) {
    const parsedResult = JSON.parse(result);
    if (parsedResult && parsedResult["error"]) {
      throw new WllamaRuntimeError("Unknown error, please see console.log", "");
    }
    return parsedResult;
  }
  /**
   * Push a new task to taskQueue
   */
  pushTask(param, buffers) {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ resolve, reject, param, buffers });
      this.runTaskLoop();
    });
  }
  /**
   * Main loop for processing tasks
   */
  async runTaskLoop() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    while (true) {
      const task = this.taskQueue.shift();
      if (!task) break;
      this.resultQueue.push(task);
      this.worker.postMessage(
        task.param,
        isSafariMobile() ? void 0 : {
          transfer: task.buffers ?? []
        }
      );
    }
    this.busy = false;
  }
  /**
   * Handle messages from worker
   */
  onRecvMsg(e) {
    if (!e.data) return;
    const { verb, args } = e.data;
    if (verb && verb.startsWith("console.")) {
      if (this.suppressNativeLog) {
        return;
      }
      if (verb.endsWith("debug")) this.logger.debug(...args);
      if (verb.endsWith("log")) this.logger.log(...args);
      if (verb.endsWith("warn")) this.logger.warn(...args);
      if (verb.endsWith("error")) this.logger.error(...args);
      return;
    } else if (verb === "signal.abort") {
      const [signalType, message, rawStack, originalErr] = args;
      if (originalErr) {
        this.logger.error(originalErr);
      }
      let stack = "";
      let newMsg = message.replace(
        "Build with -sASSERTIONS for more info.",
        ""
      );
      if (signalType === "abort") {
        newMsg = `(ABORT) ${newMsg}`;
        stack = rawStack.replace(/\|/g, "\n");
      } else if (signalType === "exception") {
        stack = rawStack;
      }
      this.logger.error(`Stack trace (${signalType}):
` + stack);
      this.abort(newMsg, stack);
      return;
    }
    if (verb === FILE_READ_REQ_EVENT) {
      const [name, offset, size] = args;
      this.fileReadResponse(name, offset, size).catch(() => {
      });
      return;
    }
    const { callbackId, result, err } = e.data;
    if (callbackId) {
      const idx = this.resultQueue.findIndex(
        (t) => t.param.callbackId === callbackId
      );
      if (idx !== -1) {
        const waitingTask = this.resultQueue.splice(idx, 1)[0];
        if (err) waitingTask.reject(err);
        else waitingTask.resolve(result);
      } else {
        this.logger.error(
          `Cannot find waiting task with callbackId = ${callbackId}`
        );
      }
    }
  }
  abort(text, stack) {
    const error = new WllamaRuntimeError(
      text.length == 0 ? "(unknown error)" : text,
      stack
    );
    while (this.resultQueue.length > 0) {
      const waitingTask = this.resultQueue.pop();
      if (!waitingTask) break;
      waitingTask.reject(error);
    }
    while (this.taskQueue.length > 0) {
      const pendingTask = this.taskQueue.pop();
      if (!pendingTask) break;
      pendingTask.reject(error);
    }
  }
};

// .wllama-build/source/src/model-manager.ts
var DEFAULT_PARALLEL_DOWNLOADS = 3;
var ModelValidationStatus = /* @__PURE__ */ ((ModelValidationStatus2) => {
  ModelValidationStatus2["VALID"] = "valid";
  ModelValidationStatus2["INVALID"] = "invalid";
  ModelValidationStatus2["DELETED"] = "deleted";
  return ModelValidationStatus2;
})(ModelValidationStatus || {});
var Model = class {
  modelManager;
  constructor(modelManager, url, mmprojUrl, savedFiles) {
    this.modelManager = modelManager;
    this.url = url;
    this.mmprojUrl = mmprojUrl;
    if (savedFiles) {
      this.files = this.getAllFiles(savedFiles);
      this.size = sumArr(this.files.map((f) => f.metadata.originalSize));
    } else {
      this.files = [];
      this.size = 0;
    }
  }
  /**
   * URL to the GGUF file (in case it contains multiple shards, the URL should point to the first shard)
   *
   * This URL will be used to identify the model in the cache. There can't be 2 models with the same URL.
   */
  url;
  /**
   * URL to mmproj file, if exists
   */
  mmprojUrl;
  /**
   * Size in bytes (total size of all shards).
   *
   * A value of -1 means the model is deleted from the cache. You must call `ModelManager.downloadModel` to re-download the model.
   */
  size;
  /**
   * List of all shards in the cache, sorted by original URL (ascending order)
   */
  files;
  /**
   * Open and get a list of all shards as Blobs
   */
  async open() {
    if (this.size === -1) {
      throw new WllamaError(
        `Model is deleted from the cache; Call ModelManager.downloadModel to re-download the model`,
        "load_error"
      );
    }
    const blobs = [];
    for (const file of this.files) {
      const blob = await this.modelManager.cacheManager.open(file.name);
      if (!blob) {
        throw new Error(
          `Failed to open file ${file.name}; Hint: the model may be invalid, please refresh it`
        );
      }
      blobs.push(blob);
    }
    return blobs;
  }
  /**
   * Validate the model files.
   *
   * If the model is invalid, the model manager will not be able to use it. You must call `refresh` to re-download the model.
   *
   * Cases that model is invalid:
   * - The model is deleted from the cache
   * - The model files are missing (or the download is interrupted)
   */
  validate() {
    let nbShards = ModelManager.parseModelUrl(this.url).length;
    if (this.mmprojUrl) {
      nbShards += 1;
    }
    if (this.size === -1) {
      return "deleted" /* DELETED */;
    }
    if (this.size < 16 || this.files.length !== nbShards) {
      return "invalid" /* INVALID */;
    }
    for (const file of this.files) {
      if (!file.metadata || file.metadata.originalSize !== file.size) {
        return "invalid" /* INVALID */;
      }
    }
    return "valid" /* VALID */;
  }
  /**
   * In case the model is invalid, call this function to re-download the model
   */
  async refresh(options = {}) {
    const urls = ModelManager.parseModelUrl(this.url);
    if (this.mmprojUrl) {
      urls.push(this.mmprojUrl);
    }
    const works = urls.map((url, index) => ({
      url,
      index
    }));
    this.modelManager.logger.debug("Downloading model files:", urls);
    const nParallel = this.modelManager.params.parallelDownloads ?? DEFAULT_PARALLEL_DOWNLOADS;
    const totalSize = await this.getTotalDownloadSize(urls);
    const loadedSize = [];
    const worker = async () => {
      while (works.length > 0) {
        const w = works.shift();
        if (!w) break;
        await this.modelManager.cacheManager.download(w.url, {
          ...options,
          metadataAdditional: {
            originalURL: w.url,
            mmprojURL: this.mmprojUrl
          },
          progressCallback: ({ loaded }) => {
            loadedSize[w.index] = loaded;
            options.progressCallback?.({
              loaded: sumArr(loadedSize),
              total: totalSize
            });
          }
        });
      }
    };
    const promises = [];
    for (let i = 0; i < nParallel; i++) {
      promises.push(worker());
      loadedSize.push(0);
    }
    await Promise.all(promises);
    this.files = this.getAllFiles(await this.modelManager.cacheManager.list());
    this.size = this.files.reduce((acc, f) => acc + f.metadata.originalSize, 0);
  }
  /**
   * Remove the model from the cache
   */
  async remove() {
    this.files = this.getAllFiles(await this.modelManager.cacheManager.list());
    await this.modelManager.cacheManager.deleteMany(
      (f) => !!this.files.find((file) => file.name === f.name)
    );
    this.size = -1;
  }
  getAllFiles(savedFiles) {
    const allUrls = new Set(ModelManager.parseModelUrl(this.url));
    if (this.mmprojUrl) {
      allUrls.add(this.mmprojUrl);
    }
    const allFiles = [];
    for (const url of allUrls) {
      const file = savedFiles.find((f) => f.metadata.originalURL === url);
      if (!file) {
        throw new Error(`Model file not found: ${url}`);
      }
      allFiles.push(file);
    }
    allFiles.sort(
      (a, b) => a.metadata.originalURL.localeCompare(b.metadata.originalURL)
    );
    return allFiles;
  }
  async getTotalDownloadSize(urls) {
    const responses = await Promise.all(
      urls.map((url) => fetch(url, { method: "HEAD" }))
    );
    const sizes = responses.map(
      (res) => Number(res.headers.get("content-length") || "0")
    );
    return sumArr(sizes);
  }
};
var ModelManager = class _ModelManager {
  // The CacheManager singleton, can be accessed by user
  cacheManager;
  params;
  logger;
  constructor(params = {}) {
    this.cacheManager = params.cacheManager || new cache_manager_default();
    this.params = params;
    this.logger = params.logger || console;
  }
  /**
   * Parses a model URL and returns an array of URLs based on the following patterns:
   * - If the input URL is an array, it returns the array itself.
   * - If the input URL is a string in the `gguf-split` format, it returns an array containing the URL of each shard in ascending order.
   * - Otherwise, it returns an array containing the input URL as a single element array.
   * @param modelUrl URL or list of URLs
   */
  static parseModelUrl(modelUrl) {
    if (Array.isArray(modelUrl)) {
      return modelUrl;
    }
    const urlPartsRegex = /-(\d{5})-of-(\d{5})\.gguf(?:\?.*)?$/;
    const queryMatch = modelUrl.match(/\.gguf(\?.*)?$/);
    const queryParams = queryMatch?.[1] ?? "";
    const matches = modelUrl.match(urlPartsRegex);
    if (!matches) {
      return [modelUrl];
    }
    const baseURL = modelUrl.replace(urlPartsRegex, "");
    const total = matches[2];
    const paddedShardIds = Array.from(
      { length: Number(total) },
      (_, index) => (index + 1).toString().padStart(5, "0")
    );
    return paddedShardIds.map(
      (current) => `${baseURL}-${current}-of-${total}.gguf${queryParams}`
    );
  }
  /**
   * Get all models in the cache
   */
  async getModels(opts = {}) {
    const cachedFiles = await this.cacheManager.list();
    let models = [];
    for (const file of cachedFiles) {
      if (!file.metadata.originalURL) continue;
      const shards = _ModelManager.parseModelUrl(file.metadata.originalURL);
      const mmprojUrl = file.metadata.mmprojURL;
      const isFirstShard = shards.length === 1 || shards[0] === file.metadata.originalURL;
      if (isFirstShard) {
        models.push(
          new Model(this, file.metadata.originalURL, mmprojUrl, cachedFiles)
        );
      }
    }
    if (!opts.includeInvalid) {
      models = models.filter(
        (m) => m.validate() === "valid" /* VALID */
      );
    }
    return models;
  }
  /**
   * Download a model from the given URL.
   *
   * The URL must end with `.gguf`
   */
  async downloadModel(sourceOrURL, options = {}) {
    const source = isString(sourceOrURL) ? { url: sourceOrURL } : sourceOrURL;
    if (!isValidGgufFile(source.url)) {
      throw new WllamaError(
        `Invalid model URL: ${source.url}; URL must ends with ".gguf"`,
        "download_error"
      );
    }
    const model = new Model(this, source.url, source.mmprojUrl);
    const validity = model.validate();
    if (validity !== "valid" /* VALID */) {
      await model.refresh(options);
    }
    return model;
  }
  /**
   * Get a model from the cache or download it if it's not available.
   */
  async getModelOrDownload(source, options = {}) {
    const models = await this.getModels();
    const model = models.find((m) => m.url === source.url);
    if (model) {
      options.progressCallback?.({ loaded: model.size, total: model.size });
      return model;
    }
    return this.downloadModel(source, options);
  }
  /**
   * Remove all models from the cache
   */
  async clear() {
    await this.cacheManager.clear();
  }
};

// .wllama-build/source/src/huggingface.ts
var HF_BASE = "https://huggingface.co";
var DEFAULT_QUANTS = ["Q4_K_M", "Q8_0"];
async function fetchRepoFiles(repo, token) {
  const url = `${HF_BASE}/api/models/${repo}/tree/main?recursive=true`;
  const headers = { Accept: "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
    }
    throw new Error(`HF API error (${res.status}): ${msg}`);
  }
  return res.json();
}
function firstShardPath(files, path) {
  const m = path.match(/^(.+)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!m) return path;
  const first = `${m[1]}-00001-of-${m[3]}.gguf`;
  return files.some((f) => f.path === first) ? first : path;
}
function selectFile(files, quant, mmprojOnly) {
  const candidates = files.filter((f) => {
    if (f.type !== "file" || !f.path.toLowerCase().endsWith(".gguf"))
      return false;
    const ismmproj = f.path.toLowerCase().includes("mmproj");
    return mmprojOnly ? ismmproj : !ismmproj;
  });
  if (candidates.length === 0) return null;
  if (quant) {
    const upper = quant.toUpperCase();
    const match = candidates.find((f) => f.path.toUpperCase().includes(upper));
    if (match) return firstShardPath(candidates, match.path);
    return null;
  }
  for (const q of DEFAULT_QUANTS) {
    const match = candidates.find((f) => f.path.toUpperCase().includes(q));
    if (match) return firstShardPath(candidates, match.path);
  }
  return firstShardPath(candidates, candidates[0].path);
}
async function getHFModelSource(config) {
  const { repo, file, quant, mmprojFile, mmprojQuant, hfToken } = config;
  const files = await fetchRepoFiles(repo, hfToken);
  const modelPath = file ?? selectFile(files, quant, false);
  if (!modelPath) {
    throw new Error(`No GGUF file found in repo "${repo}"`);
  }
  const source = {
    url: `${HF_BASE}/${repo}/resolve/main/${modelPath}`
  };
  if (mmprojFile || mmprojQuant !== void 0) {
    const mmpath = mmprojFile ?? selectFile(files, mmprojQuant, true);
    if (mmpath) {
      source.mmprojUrl = `${HF_BASE}/${repo}/resolve/main/${mmpath}`;
    }
  }
  if (hfToken) {
    const params = new URLSearchParams({ token: hfToken });
    source.url += `?${params}`;
    if (source.mmprojUrl) {
      source.mmprojUrl += `?${params}`;
    }
  }
  return source;
}
async function getHFFileSHA256(url, headers) {
  if (!url.includes("/resolve/")) return void 0;
  const rawUrl = url.replace("/resolve/", "/raw/");
  try {
    const text = await fetch(rawUrl, { headers }).then((r) => r.text());
    const match = text.match(/^oid sha256:([0-9a-f]{64})$/m);
    return match ? match[1] : void 0;
  } catch {
    return void 0;
  }
}

// .wllama-build/source/src/storage/opfs.ts
var OPFSBackend = class {
  isSupported() {
    return typeof navigator !== "undefined" && "storage" in navigator && !!navigator.storage?.getDirectory;
  }
  async read(key) {
    try {
      const cacheDir = await getCacheDir();
      const fileHandle = await cacheDir.getFileHandle(key);
      return await fileHandle.getFile();
    } catch (e) {
      return null;
    }
  }
  async write(key, stream) {
    const writable = await openWritable(key);
    await writable.truncate(0);
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
      }
    } finally {
      await writable.close();
    }
  }
  async getSize(key) {
    try {
      const cacheDir = await getCacheDir();
      const fileHandle = await cacheDir.getFileHandle(key);
      const file = await fileHandle.getFile();
      return file.size;
    } catch (e) {
      return -1;
    }
  }
  async list() {
    const cacheDir = await getCacheDir();
    const result = [];
    for await (const [name, handle] of cacheDir.entries()) {
      if (handle.kind === "file") {
        const file = await handle.getFile();
        result.push({ key: name, size: file.size });
      }
    }
    return result;
  }
  async delete(key) {
    try {
      const cacheDir = await getCacheDir();
      await cacheDir.removeEntry(key);
    } catch (e) {
      if (e?.name !== "NotFoundError") throw e;
    }
  }
};
async function getCacheDir() {
  const opfsRoot = await navigator.storage.getDirectory();
  return opfsRoot.getDirectoryHandle("cache", { create: true });
}
async function openWritable(fileName) {
  const worker = new Worker(new URL("/wllama/wllama-opfs.js", self.location.origin), { type: "module" });
  let pResolve;
  let pReject;
  worker.onmessage = (e) => {
    if (e.data.ok) pResolve(null);
    else if (e.data.err) pReject(e.data.err);
  };
  worker.onerror = (e) => pReject?.(e.message ?? e);
  const workerExec = (data) => new Promise((resolve, reject) => {
    pResolve = resolve;
    pReject = reject;
    worker.postMessage(
      data,
      isSafariMobile() ? void 0 : { transfer: "buf" in data && data.buf ? [data.buf.buffer] : [] }
    );
  });
  await workerExec({ action: "open", filename: fileName });
  return {
    truncate: async () => {
    },
    write: (value) => workerExec({ action: "write", buf: value }),
    close: async () => {
      await workerExec({ action: "close" });
      worker.terminate();
    }
  };
}

// .wllama-build/source/src/storage/cos.ts
function makeHash(key) {
  return { algorithm: "SHA-256", value: key };
}
var COSInternalBackend = class {
  isSupported() {
    return typeof navigator !== "undefined" && typeof navigator.crossOriginStorage?.getFileHandle === "function";
  }
  // IMPORTANT: key must be SHA-256 hash of the data
  async read(key) {
    try {
      const handle = await navigator.crossOriginStorage.getFileHandle(
        makeHash(key)
      );
      return handle.getFile();
    } catch {
      return null;
    }
  }
  // IMPORTANT: key must be SHA-256 hash of the data
  async write(key, stream) {
    const handle = await navigator.crossOriginStorage.getFileHandle(
      makeHash(key),
      { create: true, origins: "*" }
    );
    const writable = await handle.createWritable();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
      }
    } finally {
      await writable.close();
    }
  }
  // IMPORTANT: key must be SHA-256 hash of the data
  async getSize(key) {
    try {
      const handle = await navigator.crossOriginStorage.getFileHandle(
        makeHash(key)
      );
      const file = await handle.getFile();
      return file.size;
    } catch {
      return -1;
    }
  }
  async list() {
    throw new Error("not implemented");
  }
  async delete(_key) {
    throw new Error("not implemented");
  }
};
var COSBackend = class {
  cos = new COSInternalBackend();
  priv = new OPFSBackend();
  isSupported() {
    return this.priv.isSupported();
  }
  async read(key, hint) {
    if (hint?.sha256 && this.cos.isSupported()) {
      const blob = await this.cos.read(hint.sha256);
      if (blob) return blob;
    }
    return this.priv.read(key);
  }
  async write(key, stream, hint) {
    if (hint?.sha256 && this.cos.isSupported()) {
      await this.cos.write(hint.sha256, stream);
    } else {
      await this.priv.write(key, stream);
    }
  }
  async getSize(key, hint) {
    if (hint?.sha256 && this.cos.isSupported()) {
      const size = await this.cos.getSize(hint.sha256);
      if (size !== -1) return size;
    }
    return this.priv.getSize(key);
  }
  async list() {
    return this.priv.list();
  }
  async delete(key) {
    return this.priv.delete(key);
  }
};

// .wllama-build/source/src/cache-manager.ts
var PREFIX_METADATA = "__metadata__";
var POLYFILL_ETAG = "polyfill_for_older_version";
function hintFromMetadata(metadata) {
  if (!metadata) return void 0;
  if (metadata.sha256) return { sha256: metadata.sha256 };
  return void 0;
}
var CacheManager = class {
  sb;
  /**
   * @param backends Array of storage backends to use, in order of preference ; if first is available, use it, otherwise try the next one.
   */
  constructor(backends = [new COSBackend()]) {
    for (const backend of backends) {
      if (backend.isSupported()) {
        this.sb = backend;
        return;
      }
    }
    throw new Error("No supported storage backend found");
  }
  /**
   * Convert a given URL into a storage key.
   *
   * Format: `${hashSHA1(fullURL)}_${fileName}`
   */
  async getNameFromURL(url) {
    return urlToFileName(url, "");
  }
  /**
   * @deprecated Use `download()` instead
   *
   * Write a new file to cache. This will overwrite existing file.
   *
   * @param name The file name returned by `getNameFromURL()` or `list()`
   */
  async write(name, stream, metadata) {
    await this.sb.write(name, stream);
    await this.writeMetadata(name, metadata);
  }
  async download(url, options = {}) {
    const fileKey = await urlToFileName(url, "");
    const sha256 = await getHFFileSHA256(url, options.headers ?? {});
    const hint = sha256 ? { sha256 } : void 0;
    const cachedSize = await this.sb.getSize(fileKey, hint);
    if (cachedSize !== -1) {
      const metadata2 = await this.readMetadata(fileKey);
      if (metadata2?.originalURL === url && metadata2.originalSize === cachedSize) {
        return;
      }
      const head = await fetch(url, {
        method: "HEAD",
        ...options.headers ? { headers: options.headers } : {}
      });
      const originalSize = parseInt(
        head.headers.get("content-length") ?? "0",
        10
      );
      const etag2 = (head.headers.get("etag") || "").replace(
        /[^A-Za-z0-9]/g,
        ""
      );
      if (originalSize > 0 && originalSize === cachedSize) {
        await this.writeMetadata(fileKey, {
          originalURL: url,
          originalSize,
          etag: etag2,
          sha256,
          ...options.metadataAdditional ?? {}
        });
        return;
      }
      await this.sb.delete(fileKey);
      await this.sb.delete(`${PREFIX_METADATA}${fileKey}`);
    }
    const response = await fetch(url, {
      ...options.headers ? { headers: options.headers } : {},
      ...options.signal ? { signal: options.signal } : {}
    });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    const etag = (response.headers.get("etag") || "").replace(
      /[^A-Za-z0-9]/g,
      ""
    );
    const total = parseInt(contentLength ?? "0", 10);
    const progressCallback = options.progressCallback;
    let loaded = 0;
    let lastProgressAt = 0;
    const progressStream = new TransformStream({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        if (progressCallback) {
          const now = Date.now();
          if (now - lastProgressAt > 100) {
            lastProgressAt = now;
            progressCallback({ loaded, total });
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        progressCallback?.({ loaded, total: total || loaded });
      }
    });
    const metadata = {
      originalURL: url,
      originalSize: total,
      etag,
      ...options.metadataAdditional ?? {}
    };
    if (sha256) {
      metadata.sha256 = sha256;
    }
    await this.sb.write(
      fileKey,
      response.body.pipeThrough(progressStream),
      hint
    );
    await this.writeMetadata(fileKey, metadata);
  }
  /**
   * Open a file in cache for reading
   *
   * @param nameOrURL The file name returned by `getNameFromURL()` or `list()`, or the original URL of the remote file
   * @returns Blob, or null if file does not exist
   */
  async open(nameOrURL) {
    const hint1 = hintFromMetadata(await this.getMetadata(nameOrURL));
    const direct = await this.sb.read(nameOrURL, hint1);
    if (direct) return direct;
    const key = await urlToFileName(nameOrURL, "");
    const hint2 = hintFromMetadata(await this.getMetadata(key));
    return this.sb.read(key, hint2);
  }
  /**
   * Get the size of a file in stored cache
   *
   * NOTE: in case the download is stopped mid-way (i.e. user close browser tab), the file maybe corrupted, size maybe different from `metadata.originalSize`
   *
   * @param name The file name returned by `getNameFromURL()` or `list()`
   * @returns number of bytes, or -1 if file does not exist
   */
  async getSize(name) {
    const hint = hintFromMetadata(await this.getMetadata(name));
    return this.sb.getSize(name, hint);
  }
  /**
   * Get metadata of a cached file
   */
  async getMetadata(name) {
    const metadata = await this.readMetadata(name);
    if (metadata) return metadata;
    const cachedSize = await this.sb.getSize(name);
    return cachedSize > 0 ? (
      // files created by older version of wllama don't have metadata; polyfill it
      {
        etag: POLYFILL_ETAG,
        originalSize: cachedSize,
        originalURL: ""
      }
    ) : (
      // cached file not found
      null
    );
  }
  /**
   * Same as `getMetadata()`, but without polyfill. Returns null if the file has no metadata.
   */
  async readMetadata(name) {
    const blob = await this.sb.read(`${PREFIX_METADATA}${name}`);
    if (!blob) return null;
    try {
      return await new Response(blob).json();
    } catch (e) {
      return null;
    }
  }
  /**
   * List all files currently in cache
   */
  async list() {
    const all = await this.sb.list();
    const metadataMap = {};
    for (const { key } of all) {
      if (key.startsWith(PREFIX_METADATA)) {
        const blob = await this.sb.read(key);
        if (blob) {
          const meta = await new Response(blob).json().catch(() => null);
          metadataMap[key.slice(PREFIX_METADATA.length)] = meta;
        }
      }
    }
    const result = [];
    for (const { key, size } of all) {
      if (!key.startsWith(PREFIX_METADATA)) {
        result.push({
          name: key,
          size,
          metadata: metadataMap[key] || {
            originalSize: size,
            originalURL: "",
            etag: ""
          }
        });
      }
    }
    return result;
  }
  /**
   * Clear all files currently in cache
   */
  async clear() {
    await this.deleteMany(() => true);
  }
  /**
   * Delete a single file in cache
   *
   * @param nameOrURL Can be either an URL or a name returned by `getNameFromURL()` or `list()`
   */
  async delete(nameOrURL) {
    const name2 = await this.getNameFromURL(nameOrURL);
    await this.deleteMany(
      (entry) => entry.name === nameOrURL || entry.name === name2
    );
  }
  /**
   * Delete multiple files in cache.
   *
   * @param predicate A predicate like `array.filter(item => boolean)`
   */
  async deleteMany(predicate) {
    const list = await this.list();
    for (const item of list) {
      if (predicate(item)) {
        await this.sb.delete(item.name);
        await this.sb.delete(`${PREFIX_METADATA}${item.name}`);
      }
    }
  }
  /**
   * Write the metadata of the file to disk.
   */
  async writeMetadata(name, metadata) {
    const blob = new Blob([JSON.stringify(metadata)], { type: "text/plain" });
    await this.sb.write(`${PREFIX_METADATA}${name}`, blob.stream());
  }
};
var cache_manager_default = CacheManager;
async function urlToFileName(url, prefix) {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(url)
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hashHex}_${url.split("/").pop()}`;
}

// .wllama-build/source/src/workers-code/generated.ts
var LIBLLAMA_VERSION = "b12162-d38bea3";

// .wllama-build/source/src/types/types.ts
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["DEBUG"] = 1] = "DEBUG";
  LogLevel2[LogLevel2["INFO"] = 2] = "INFO";
  LogLevel2[LogLevel2["WARN"] = 3] = "WARN";
  LogLevel2[LogLevel2["ERROR"] = 4] = "ERROR";
  return LogLevel2;
})(LogLevel || {});

// .wllama-build/source/src/wasm-from-cdn.ts
var WasmCompatFromCDN = {
  worker: "https://cdn.jsdelivr.net/npm/@wllama/wllama-compat@3.12.0/wasm/wllama.js",
  wasm: "https://cdn.jsdelivr.net/npm/@wllama/wllama-compat@3.12.0/wasm/wllama.wasm"
};

// .wllama-build/source/src/wllama.ts
var LoggerWithoutDebug = {
  ...console,
  debug: () => {
  }
};
var WllamaError = class extends Error {
  type;
  constructor(message, type = "unknown_error") {
    super(message);
    this.type = type;
  }
};
var WllamaAbortError = class extends Error {
  name = "AbortError";
  constructor() {
    super("Operation aborted");
  }
};
var WllamaRuntimeError = class extends Error {
  name = "RuntimeError";
  stack;
  constructor(message, stack) {
    super(message);
    this.stack = stack;
  }
};
var Wllama = class {
  // The CacheManager and ModelManager are singleton, can be accessed by user
  cacheManager;
  modelManager;
  compat = null;
  proxy = null;
  config;
  pathConfig;
  useMultiThread = false;
  nbThreads = 1;
  useEmbeddings = false;
  useRerank = false;
  // available when loaded
  loadedContextInfo = null;
  seed = void 0;
  bosToken = -1;
  eosToken = -1;
  eotToken = -1;
  eogTokens = /* @__PURE__ */ new Set();
  addBosToken = false;
  addEosToken = false;
  mediaMarker;
  chatTemplate;
  metadata;
  hasEncoder = false;
  decoderStartToken = -1;
  // note: we overlay instead of using llama-server default_template_kwargs, because we cannot transfer complex data structure via GLUE
  // overlay allow mixed data type or nested structure for kwargs
  chatTemplateKwargs = {};
  constructor(pathConfig, wllamaConfig = {}) {
    checkEnvironmentCompatible();
    if (!pathConfig) throw new WllamaError("AssetsPathConfig is required");
    this.pathConfig = pathConfig;
    this.config = wllamaConfig;
    this.cacheManager = wllamaConfig.cacheManager ?? new cache_manager_default();
    this.modelManager = wllamaConfig.modelManager ?? new ModelManager({
      cacheManager: this.cacheManager,
      logger: wllamaConfig.logger ?? console,
      parallelDownloads: wllamaConfig.parallelDownloads,
      allowOffline: wllamaConfig.allowOffline
    });
    this.setCompat("default");
  }
  logger() {
    return this.config.logger ?? console;
  }
  checkModelLoaded() {
    if (!this.isModelLoaded()) {
      throw new WllamaError(
        "loadModel() is not yet called",
        "model_not_loaded"
      );
    }
  }
  /**
   * Get the libllama version string, e.g. "b6327-4d74393".
   *
   * @returns version string embedded at build time.
   */
  static getLibllamaVersion() {
    return LIBLLAMA_VERSION;
  }
  /**
   * Set compatibility options for Wllama.
   * @param compat Set to null to disable compatibility, or 'default' to use the default compat resources from CDN.
   * @param mode 'safari' by default; If set to 'firefox_safari', the compat mode will **also** be enabled on Firefox, which will significantly degrade the performance but allow using WebGPU on Firefox.
   */
  setCompat(compat, mode = "safari") {
    if (mode === "safari") {
      if (isFirefox()) {
        this.compat = null;
        return;
      }
    }
    this.compat = compat === "default" ? WasmCompatFromCDN : compat;
  }
  /**
   * Check if the model is loaded via `loadModel()`
   */
  isModelLoaded() {
    return !!this.proxy && !!this.metadata;
  }
  /**
   * Get token ID associated to BOS (begin of sentence) token.
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns -1 if the model is not loaded.
   */
  getBOS() {
    return this.bosToken;
  }
  /**
   * Get token ID associated to EOS (end of sentence) token.
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns -1 if the model is not loaded.
   */
  getEOS() {
    return this.eosToken;
  }
  /**
   * Get token ID associated to EOT (end of turn) token.
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns -1 if the model is not loaded.
   */
  getEOT() {
    return this.eotToken;
  }
  /**
   * Check if a given token is end-of-generation token (e.g. EOS, EOT, etc.)
   *
   * @param token the token ID to be checked
   * @returns true if the token is EOS, EOT, or any other end-of-generation tokens
   */
  isTokenEOG(token) {
    return token === this.eosToken || token === this.eotToken || this.eogTokens.has(token);
  }
  /**
   * Get token ID associated to token used by decoder, to start generating output sequence(only usable for encoder-decoder architecture). In other words, encoder uses normal BOS and decoder uses this token.
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns -1 if the model is not loaded.
   */
  getDecoderStartToken() {
    return this.decoderStartToken;
  }
  /**
   * Get model hyper-parameters and metadata
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns ModelMetadata
   */
  getModelMetadata() {
    this.checkModelLoaded();
    return this.metadata;
  }
  /**
   * Check if we're currently using multi-thread build.
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns true if multi-thread is used.
   */
  isMultithread() {
    this.checkModelLoaded();
    return this.useMultiThread;
  }
  /**
   * Get number of threads used in the current context.
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns number of threads
   */
  getNumThreads() {
    this.checkModelLoaded();
    return this.useMultiThread ? this.nbThreads : 1;
  }
  /**
   * Check if the current model uses encoder-decoder architecture
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns true if multi-thread is used.
   */
  isEncoderDecoderArchitecture() {
    this.checkModelLoaded();
    return this.hasEncoder;
  }
  /**
   * Must we add BOS token to the tokenized sequence?
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns true if BOS token must be added to the sequence
   */
  mustAddBosToken() {
    this.checkModelLoaded();
    return this.addBosToken;
  }
  /**
   * Must we add EOS token to the tokenized sequence?
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns true if EOS token must be added to the sequence
   */
  mustAddEosToken() {
    this.checkModelLoaded();
    return this.addEosToken;
  }
  /**
   * Get the jinja chat template comes with the model. It only available if the original model (before converting to gguf) has the template in `tokenizer_config.json`
   *
   * NOTE: This can only being used after `loadModel` is called.
   *
   * @returns the jinja template. null if there is no template in gguf
   */
  getChatTemplate() {
    this.checkModelLoaded();
    return this.chatTemplate ?? null;
  }
  /**
   * Check if WebGPU is supported by the current environment.
   * @returns true if WebGPU is supported
   */
  isSupportWebGPU() {
    return isSupportWebGPU();
  }
  /**
   * Load model from a given URL (or a list of URLs, in case the model is splitted into smaller files)
   * - If the model already been downloaded (via `downloadModel()`), then we will use the cached model
   * - Else, we download the model from internet
   * @param modelSourceOrURL
   * @param params
   */
  async loadModelFromUrl(modelSourceOrURL, params = {}) {
    const source = isString(modelSourceOrURL) ? { url: modelSourceOrURL } : modelSourceOrURL;
    const useCache = params.useCache ?? true;
    const model = useCache ? await this.modelManager.getModelOrDownload(source, params) : await this.modelManager.downloadModel(source, params);
    const blobs = await model.open();
    return await this.loadModel(blobs, params);
  }
  /**
   * Load model from a given Hugging Face model ID and file path.
   *
   * @param hfOptions
   * @param params
   */
  async loadModelFromHF(hfOptions, params = {}) {
    const source = await getHFModelSource(hfOptions);
    return await this.loadModelFromUrl(source, params);
  }
  /**
   * Load model from a given list of Blob.
   *
   * You can pass multiple buffers into the function (in case the model contains multiple shards).
   *
   * @param ggufBlobsOrModel Can be either list of Blobs (in case you use local file), or a Model object (in case you use ModelManager)
   * @param params LoadModelParams
   */
  async loadModel(ggufBlobsOrModel, params = {}) {
    const blobs = ggufBlobsOrModel instanceof Model ? await ggufBlobsOrModel.open() : [...ggufBlobsOrModel];
    if (blobs.some((b) => b.size === 0)) {
      throw new WllamaError(
        "Input model (or splits) must be non-empty Blob or File",
        "load_error"
      );
    }
    if (!this.pathConfig["default"]) {
      throw new WllamaError(
        '"default" is missing from pathConfig',
        "load_error"
      );
    }
    if (this.proxy) {
      throw new WllamaError("Module is already initialized", "load_error");
    }
    const supportMultiThread = await isSupportMultiThread();
    const hwConccurency = Math.floor((navigator.hardwareConcurrency || 1) / 2);
    const nbThreads = params.n_threads ?? hwConccurency;
    this.nbThreads = nbThreads;
    this.useMultiThread = supportMultiThread && nbThreads > 1;
    const workerResources = this.getWorkerResources();
    if (params.n_gpu_layers === 0) {
      workerResources.noWebGPU = true;
    }
    this.proxy = new ProxyToWorker(
      workerResources,
      this.useMultiThread ? nbThreads : 0,
      // 0 means disable pthread
      this.config.suppressNativeLog ?? false,
      this.logger()
    );
    let logLevel = params.log_level ?? 2 /* INFO */;
    if (this.config.suppressNativeLog) {
      logLevel = 9999;
    }
    const modelFiles = await prepareBlobs(blobs);
    await this.proxy.moduleInit(modelFiles.all);
    this.logger().debug("Calling wllamaStart...");
    const startResult = await this.proxy.wllamaStart();
    if (!startResult.success) {
      throw new WllamaError(
        `Error while calling start function, result = ${startResult}`
      );
    }
    await this.checkWasmVersion(startResult.version);
    this.logger().debug("Loading model...");
    const loadResult = await this.proxy.wllamaAction("load", {
      _name: "load_req",
      log_level: logLevel,
      // if async read is not supported, use mmap; refer to README-dev.md for more details
      use_mmap: !canUseAsyncFileRead(workerResources.compat),
      use_mlock: false,
      n_gpu_layers: params.n_gpu_layers ?? 99999,
      n_ctx: params.n_ctx ?? 1024,
      n_threads: this.useMultiThread ? nbThreads : 1,
      n_ctx_auto: false,
      // not supported for now
      mmproj_path: modelFiles.mmproj ? `/models/${MMPROJ_FILE_NAME}` : void 0,
      model_paths: modelFiles.llm.map((f) => `models/${f.name}`),
      embeddings: params.embeddings,
      offload_kqv: params.offload_kqv,
      n_batch: params.n_batch,
      n_ubatch: params.n_ubatch,
      pooling_type: params.pooling_type,
      rope_scaling_type: params.rope_scaling_type,
      rope_freq_base: params.rope_freq_base,
      rope_freq_scale: params.rope_freq_scale,
      yarn_ext_factor: params.yarn_ext_factor,
      yarn_attn_factor: params.yarn_attn_factor,
      yarn_beta_fast: params.yarn_beta_fast,
      yarn_beta_slow: params.yarn_beta_slow,
      yarn_orig_ctx: params.yarn_orig_ctx,
      cache_type_k: params.cache_type_k,
      cache_type_v: params.cache_type_v,
      // with unified KV, all sequences share one n_ctx cache, so each request can still use the full context
      n_parallel: params.n_parallel ?? 4,
      kv_unified: params.kv_unified ?? true,
      flash_attn: params.flash_attn,
      swa_full: params.swa_full,
      chat_template: params.chat_template,
      jinja: params.jinja,
      reasoning: params.reasoning,
      image_min_tokens: params.image_min_tokens,
      image_max_tokens: params.image_max_tokens,
      warmup: params.warmup,
      no_kv_offload: params.no_kv_offload,
      mmproj_offload: params.mmproj_offload,
      cont_batching: params.cont_batching,
      n_keep: params.n_keep,
      ctx_shift: params.ctx_shift,
      cache_idle_slots: params.cache_idle_slots,
      n_cache_reuse: params.n_cache_reuse,
      lora_paths: params.lora_adapters?.map((a) => a.path),
      lora_scales: params.lora_adapters?.map((a) => a.scale ?? 1),
      lora_init_without_apply: params.lora_init_without_apply,
      spec_draft_model: params.spec_draft_model,
      spec_draft_ngl: params.spec_draft_ngl,
      spec_draft_n_max: params.spec_draft_n_max,
      spec_draft_n_min: params.spec_draft_n_min,
      spec_draft_p_min: params.spec_draft_p_min,
      spec_draft_threads: params.spec_draft_threads,
      spec_draft_threads_batch: params.spec_draft_threads_batch,
      kv_overrides_keys: params.kv_overrides ? Object.keys(params.kv_overrides) : void 0,
      kv_overrides_vals: params.kv_overrides ? Object.values(params.kv_overrides) : void 0,
      reasoning_budget_tokens: params.reasoning_budget_tokens,
      reasoning_budget_message: params.reasoning_budget_message,
      reasoning_format: params.reasoning_format,
      skip_chat_parsing: params.skip_chat_parsing,
      prefill_assistant: params.prefill_assistant
    });
    const loadedCtxInfo = {
      ...loadResult,
      metadata: {}
    };
    for (let i = 0; i < loadResult.metadata_key.length; i++) {
      loadedCtxInfo.metadata[loadResult.metadata_key[i]] = loadResult.metadata_val[i];
    }
    this.seed = params.seed;
    this.bosToken = loadedCtxInfo.token_bos;
    this.eosToken = loadedCtxInfo.token_eos;
    this.eotToken = loadedCtxInfo.token_eot;
    this.useEmbeddings = !!params.embeddings;
    this.useRerank = params.pooling_type == "rank";
    this.metadata = {
      hparams: {
        nVocab: loadedCtxInfo.n_vocab,
        nCtxTrain: loadedCtxInfo.n_ctx_train,
        nEmbd: loadedCtxInfo.n_embd,
        nLayer: loadedCtxInfo.n_layer
      },
      meta: loadedCtxInfo.metadata
    };
    this.hasEncoder = !!loadedCtxInfo.has_encoder;
    this.decoderStartToken = loadedCtxInfo.token_decoder_start;
    this.addBosToken = loadedCtxInfo.add_bos_token;
    this.addEosToken = loadedCtxInfo.add_eos_token;
    this.chatTemplate = loadedCtxInfo.metadata["tokenizer.chat_template"];
    this.loadedContextInfo = loadedCtxInfo;
    this.eogTokens = new Set(loadedCtxInfo.list_tokens_eog);
    this.mediaMarker = loadedCtxInfo.media_marker;
    this.chatTemplateKwargs = params.default_template_kwargs ?? {};
    this.logger().debug({ loadedCtxInfo });
  }
  getLoadedContextInfo() {
    this.checkModelLoaded();
    if (!this.loadedContextInfo) {
      throw new WllamaError("Loaded context info is not available");
    }
    return { ...this.loadedContextInfo };
  }
  //////////////////////////////////////////////
  // High level API
  /**
   * Calculate embedding vector for a given text or multimodal input.
   * By default, BOS and EOS tokens will be added automatically. You can use the "skipBOS" and "skipEOS" option to disable it.
   * @param options OAI-compatible embedding creation options
   * @returns OAI-compatible embedding response
   */
  async createEmbedding(options) {
    this.checkModelLoaded();
    if (!this.useEmbeddings) {
      throw new WllamaError(
        "Embeddings is not enabled. Please set it via LoadModelParams.embeddings"
      );
    }
    if (options.embd_normalize !== void 0 && (!Number.isInteger(options.embd_normalize) || options.embd_normalize < -1)) {
      throw new WllamaError(
        "embd_normalize must be an integer >= -1",
        "inference_error"
      );
    }
    const { input, files } = this.prepareEmbeddingInput(options.input);
    const result = await this.proxy.wllamaAction(
      "embedding",
      {
        _name: "embd_req",
        data_json: JSON.stringify({ ...options, input }),
        files: files.map((f) => new Uint8Array(f))
      }
    );
    if (!result.success) {
      throw new WllamaError(
        result.message || "Model failed to start inference",
        "inference_error"
      );
    }
    return await this.getResponse(options, false, result.req_id);
  }
  /**
   * Rerank a list of documents against a query.
   * Requires the model to be loaded with embeddings: true and pooling_type: 'rank'.
   * @param options Reranking options (query, documents, top_n)
   * @returns Reranking response with relevance scores sorted highest first
   */
  async createRerank(options) {
    this.checkModelLoaded();
    if (!this.useEmbeddings || !this.useRerank) {
      throw new WllamaError(
        "Rerank is not enabled. Please set it via LoadModelParams: embeddings = true and pooling_type = rank"
      );
    }
    const top_n = options.top_n ?? options.documents.length;
    let totalTokens = 0;
    const rawResults = [];
    for (let i = 0; i < options.documents.length; i++) {
      const result = await this.proxy.wllamaAction("rerank", {
        _name: "rrnk_req",
        data_json: JSON.stringify({
          query: options.query,
          document: options.documents[i]
        })
      });
      if (!result.success) {
        throw new WllamaError(
          "Model failed to start reranking",
          "inference_error"
        );
      }
      const { score, tokens_evaluated } = await this.getSingleResult(result.req_id, "reranking");
      totalTokens += tokens_evaluated;
      rawResults.push({ index: i, score });
    }
    rawResults.sort((a, b) => b.score - a.score);
    return {
      model: this.getModelMetadata().meta["general.name"] ?? "",
      object: "list",
      usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
      results: rawResults.slice(0, top_n).map(({ index, score }) => ({
        index,
        relevance_score: score
      }))
    };
  }
  /**
   * Answer typed questions about a state, using a decision model (TypeSafe-compatible System One API).
   * Image input is not supported yet.
   * @param options The state and the questions
   * @returns The answer of each question
   */
  async createSystemOne(options) {
    this.checkModelLoaded();
    const result = await this.proxy.wllamaAction(
      "systemone",
      {
        _name: "sys1_req",
        data_json: JSON.stringify(options)
      }
    );
    if (!result.success) {
      throw new WllamaError(
        "Model failed to start systemone",
        "inference_error"
      );
    }
    return await this.getSingleResult(
      result.req_id,
      "systemone"
    );
  }
  async createChatCompletion(options) {
    if (Object.keys(this.chatTemplateKwargs).length > 0) {
      options = {
        ...options,
        chat_template_kwargs: {
          ...this.chatTemplateKwargs,
          ...options.chat_template_kwargs ?? {}
        }
      };
    }
    if (options.stream && options.onData) {
      await this.createCompletionImpl(options);
    } else if (options.stream) {
      return await this.createCompletionGenerator(options);
    } else {
      return await this.createCompletionImpl({ ...options, stream: false });
    }
  }
  async createCompletion(options) {
    if (options.stream && options.onData) {
      await this.createCompletionImpl(options);
    } else if (options.stream) {
      return await this.createCompletionGenerator(options);
    } else {
      return await this.createCompletionImpl({ ...options, stream: false });
    }
  }
  /**
   * Private implementation of createCompletion
   */
  async createCompletionImpl(options) {
    this.checkModelLoaded();
    const isStream = !!options.stream;
    const isChat = !!options.messages;
    const customOpt = {};
    if (this.seed !== void 0) {
      customOpt.seed = this.seed;
    }
    let files = [];
    if (isChat) {
      const tmp = this.prepareMultimodalInput(
        options
      );
      options = tmp.params;
      files = tmp.files;
    }
    const result = await this.proxy.wllamaAction(
      "completion",
      {
        _name: "cmpl_req",
        is_chat: isChat,
        data_json: JSON.stringify({ ...options, ...customOpt }),
        files: files.map((f) => new Uint8Array(f))
      }
    );
    if (!result.success) {
      throw new WllamaError(
        "Model failed to start inference",
        "inference_error"
      );
    }
    return await this.getResponse(
      options,
      isStream,
      result.req_id
    );
  }
  /**
   * Same with `createCompletion`, but returns an async iterator instead.
   * Only called when stream=true and no onData is provided.
   */
  createCompletionGenerator(options) {
    return new Promise((resolve) => {
      const createGenerator = cbToAsyncIter(
        (callback) => {
          this.createCompletionImpl({
            ...options,
            onData: (chunk) => callback(chunk)
          }).then(() => callback(void 0, true)).catch((err) => callback(void 0, false, err));
        }
      );
      resolve(createGenerator());
    });
  }
  /**
   * Whether the currently loaded model supports a specific input modality (e.g. image or audio).
   * @param modality
   * @returns
   */
  supportInputModality(modality) {
    this.checkModelLoaded();
    if (modality === "image") {
      return !!this.loadedContextInfo.has_image_input;
    } else if (modality === "audio") {
      return !!this.loadedContextInfo.has_audio_input;
    } else {
      throw new WllamaError(
        "Unsupported modality: " + modality,
        "unknown_error"
      );
    }
  }
  /**
   * Unload the model and free all memory.
   *
   * Note: This function will NOT crash if model is not yet loaded
   */
  async exit() {
    await this.proxy?.wllamaExit();
    this.proxy = null;
  }
  /**
   * [FOR DEBUGGING ONLY] Run ggml backend ops tests without loading any model.
   *
   * Initializes the wasm runtime, executes `test-backend-ops` with the given args, then shuts down.
   *
   * For more info, please refer to guides/debug.md
   *
   * @param args Arguments forwarded to test-backend-ops (e.g. ["-o", "ADD"])
   * @returns retcode (0 = all tests passed) and success flag
   */
  async testBackendOps(args = []) {
    if (!this.pathConfig["default"]) {
      throw new WllamaError(
        '"default" is missing from pathConfig',
        "load_error"
      );
    }
    if (!await isSupportMultiThread()) {
      throw new WllamaError(
        "Multi-threading is required to run backend ops tests, but it is not supported in the current environment."
      );
    }
    const tmpProxy = new ProxyToWorker(
      this.getWorkerResources(),
      0,
      // single-thread; no model needed
      this.config.suppressNativeLog ?? false,
      this.logger()
    );
    try {
      await tmpProxy.moduleInit([]);
      const startResult = await tmpProxy.wllamaStart();
      if (!startResult.success) {
        throw new WllamaError(
          `Error while calling start function, result = ${startResult}`
        );
      }
      const result = await tmpProxy.wllamaAction(
        "test_backend_ops",
        { _name: "tbop_req", args: ["test-backend-ops", ...args] }
      );
      return { retcode: result.retcode, success: result.success };
    } finally {
      await tmpProxy.wllamaExit();
    }
  }
  //////////////////////////////////////////////
  // Low level API
  // TODO: add back
  /**
   * get debug info
   */
  async _getDebugInfo() {
    this.checkModelLoaded();
    return await this.proxy.wllamaDebug();
  }
  //////////////////////////////////////////////
  // Utils
  jsonDecode(data_json) {
    try {
      return JSON.parse(data_json);
    } catch (e) {
      this.logger().error("Failed to parse JSON:", data_json);
      throw new WllamaError("Failed to parse model output", "inference_error");
    }
  }
  replaceMedia(content, files) {
    return content.map((c) => {
      if (c.type === "text") {
        return c;
      }
      if (!this.mediaMarker) {
        throw new WllamaError("Media marker is undefined", "inference_error");
      }
      files.push(c.data);
      return { type: "text", text: this.mediaMarker };
    });
  }
  prepareMultimodalInput(params) {
    const msg = params.messages;
    const msgNew = [];
    const files = [];
    for (const m of msg) {
      if (Array.isArray(m.content)) {
        msgNew.push({
          ...m,
          content: this.replaceMedia(m.content, files)
        });
      } else {
        msgNew.push(m);
      }
    }
    return {
      params: {
        ...params,
        messages: msgNew
      },
      files
    };
  }
  prepareEmbeddingInput(input) {
    const files = [];
    const isContentPart = (entry) => typeof entry === "object" && entry !== null && "type" in entry && (entry.type === "text" || entry.type === "image");
    const isContent = (entry) => Array.isArray(entry) && entry.length > 0 && entry.every(isContentPart);
    const toText = (content) => {
      if (content.some((c) => c.type === "text" && typeof c.text !== "string")) {
        throw new WllamaError(
          'Text input must contain a string in "text"',
          "inference_error"
        );
      }
      const text = this.replaceMedia(content, files).map((c) => c.text).join("");
      if (text.length === 0) {
        throw new WllamaError(
          "Input content cannot be empty",
          "inference_error"
        );
      }
      return text;
    };
    let prepared = input;
    if (isContent(input)) {
      prepared = toText(input);
    } else if (Array.isArray(input) && input.length > 0 && input.every(isContent)) {
      prepared = input.map(toText);
    }
    if (files.length > 0 && !this.supportInputModality("image")) {
      throw new WllamaError(
        "Image input is not supported by the loaded model",
        "inference_error"
      );
    }
    return { input: prepared, files };
  }
  // release the slot occupied by the request; cancelling an already-finished request is a no-op
  async cancelRequest(reqId) {
    try {
      await this.proxy.wllamaAction("cancel", {
        _name: "cncl_req",
        req_id: reqId
      });
    } catch (e) {
      this.logger().warn("Failed to cancel request", reqId, e);
    }
  }
  async getSingleResult(reqId, task) {
    let completed = false;
    try {
      while (true) {
        const chunk = await this.proxy.wllamaAction(
          "get_result",
          { _name: "gres_req", req_id: reqId }
        );
        const jsonString = chunk.data_json;
        if (jsonString && jsonString.length > 0) {
          if (chunk.is_error) {
            const jsonData = this.jsonDecode(jsonString);
            throw new WllamaError(
              jsonData.message || `Unknown ${task} error`,
              "inference_error"
            );
          }
          completed = true;
          return this.jsonDecode(jsonString);
        }
        if (!chunk.has_more) {
          completed = true;
          break;
        }
      }
      throw new WllamaError(`No ${task} result received`, "inference_error");
    } finally {
      if (!completed) {
        await this.cancelRequest(reqId);
      }
    }
  }
  async getResponse(options, isStream, reqId) {
    let finalResult = null;
    let completed = false;
    try {
      while (true) {
        if (options.abortSignal?.aborted) {
          throw new WllamaAbortError();
        }
        const result_chunk = await this.proxy.wllamaAction(
          "get_result",
          {
            _name: "gres_req",
            req_id: reqId
          }
        );
        const jsonString = result_chunk.data_json;
        if (!jsonString || jsonString.length === 0) {
          if (!result_chunk.has_more) {
            completed = true;
            break;
          } else {
            continue;
          }
        }
        if (jsonString == "null") {
          continue;
        }
        let jsonData = this.jsonDecode(jsonString);
        finalResult = jsonData;
        if (result_chunk.is_error) {
          this.logger().error("Model returned an error:", jsonData);
          throw new WllamaError(
            jsonData.message || "Unknown inference error",
            "inference_error"
          );
        }
        if (isStream) {
          if (!Array.isArray(jsonData)) {
            jsonData = [jsonData];
          }
          for (const chunk of jsonData) {
            options.onData?.(chunk);
            finalResult = chunk;
          }
        }
        if (!result_chunk.has_more) {
          completed = true;
          break;
        }
      }
    } finally {
      if (!completed) {
        await this.cancelRequest(reqId);
      }
    }
    return finalResult;
  }
  async checkWasmVersion(wasmVersion) {
    const getCommit = (version) => version?.split("-").pop();
    if (getCommit(wasmVersion) === getCommit(LIBLLAMA_VERSION)) {
      return;
    }
    const message = `wasm file version (${wasmVersion ?? "unknown"}) does not match the expected version (${LIBLLAMA_VERSION})`;
    if (this.config.skipVersionCheck) {
      this.logger().warn(message);
      return;
    }
    await this.exit();
    throw new WllamaError(
      `${message}. Use the wasm file from the same release, or set skipVersionCheck to ignore this error`,
      "version_mismatch"
    );
  }
  getWorkerResources() {
    const workerResources = {
      wasmPath: absoluteUrl(this.pathConfig["default"]),
      compat: false
    };
    if (needCompat()) {
      if (!this.compat) {
        this.logger().warn(
          "Not using compat mode" + (isFirefox() ? " (expected on Firefox - WebGPU will be disabled)" : "")
        );
      } else {
        const isUsingDefault = this.compat.worker === WasmCompatFromCDN.worker && this.compat.wasm === WasmCompatFromCDN.wasm;
        if (isUsingDefault) {
          this.logger().warn(
            "Compatibility mode is activated, using resources from CDN. To use local resources, please refer to @wllama/wllama-compat package."
          );
          this.logger().warn(
            "IMPORTANT: Performance will be significantly degraded in compatibility mode."
          );
        }
        workerResources.wasmPath = absoluteUrl(this.compat.wasm);
        workerResources.jsPath = this.compat.worker;
        workerResources.compat = true;
      }
    }
    if (isFirefox()) {
      if (workerResources.compat) {
        this.logger().warn(
          'Using compat mode on Firefox, performance will be significantly degraded; Consider enabling "javascript.options.wasm_js_promise_integration" in "about:config".'
        );
      } else if (!isSupportJSPI()) {
        this.logger().warn(
          'WebGPU is disabled on Firefox due to missing JSPI support. Please consider enabling compat mode, or enabling "javascript.options.wasm_js_promise_integration" in "about:config".'
        );
      }
    }
    return workerResources;
  }
};
export {
  CacheManager,
  LogLevel,
  LoggerWithoutDebug,
  Model,
  ModelManager,
  ModelValidationStatus,
  POLYFILL_ETAG,
  Wllama,
  WllamaAbortError,
  WllamaError,
  WllamaRuntimeError,
  getHFFileSHA256,
  getHFModelSource,
  isValidGgufFile
};
