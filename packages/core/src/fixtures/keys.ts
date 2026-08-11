import type { KeyPairRecord } from "../keys.js";

export type DemoKey = KeyPairRecord;

export const principalKey: DemoKey = {
  "keyId": "key:principal:pfBPZULv_ocFK2ic",
  "subject": "Priya Sharma, Finance Head, Meridian Technologies Pvt Ltd",
  "role": "principal",
  "publicKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "Vc1k9rnQP3G5rvfWy5EAJwfi65tKRSbcD-1H35qXa2k",
    "y": "qsvoNZe97i2a2d4VYPpnInGJBiksXR3WLr46iNXHaXM"
  },
  "privateKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "Vc1k9rnQP3G5rvfWy5EAJwfi65tKRSbcD-1H35qXa2k",
    "y": "qsvoNZe97i2a2d4VYPpnInGJBiksXR3WLr46iNXHaXM",
    "d": "4weIbaPa8fD08wYKDXnQF39TpVLXtNC7o3iF8RJbPYc"
  }
};

export const apAgentKey: DemoKey = {
  "keyId": "key:agent:9FZkZ2oHq9rsZvVS",
  "subject": "AP-Agent-01, accounts payable agent",
  "role": "agent",
  "publicKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "9vTxnsjQQFxveM_nhpb22CqyGed1-Uk2hd1cCiHhna8",
    "y": "qZ4hyrG-KTId5kNCk8fM_Qn0OSqNpoOXwlLFPlnAxdk"
  },
  "privateKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "9vTxnsjQQFxveM_nhpb22CqyGed1-Uk2hd1cCiHhna8",
    "y": "qZ4hyrG-KTId5kNCk8fM_Qn0OSqNpoOXwlLFPlnAxdk",
    "d": "7rIN_JRnTgjqTeS8Worao1TcKfpXi5MNCW6JSCvopDQ"
  }
};

export const payAgentKey: DemoKey = {
  "keyId": "key:agent:f6EYkbTNfJfWIsDv",
  "subject": "PAY-Agent-07, payment execution agent",
  "role": "agent",
  "publicKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "PcHPo19ZLN-YgC0gzbqojFLOhwUfJ5K6ej0xjqBuxP4",
    "y": "2fvXiYipMKwAelA9_qrCN5Pq79t1SSz1lNIzlY5wtzc"
  },
  "privateKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "PcHPo19ZLN-YgC0gzbqojFLOhwUfJ5K6ej0xjqBuxP4",
    "y": "2fvXiYipMKwAelA9_qrCN5Pq79t1SSz1lNIzlY5wtzc",
    "d": "-Wui_fssamXSxoVegZLDQ0XT6nhm9J0E2WaXs_NaEpQ"
  }
};

export const settleAgentKey: DemoKey = {
  "keyId": "key:agent:kfiR1GRUqNWRVEtR",
  "subject": "SETTLE-Agent-12, settlement agent",
  "role": "agent",
  "publicKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "nZPmrabRxinDtSAlRCAiGQ-tkdgoEKMIeWIjyDuOnb8",
    "y": "cLTEJdCaq3L0Z6sj1C0_5vey-8zLhQawTv9ee9hbRog"
  },
  "privateKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "nZPmrabRxinDtSAlRCAiGQ-tkdgoEKMIeWIjyDuOnb8",
    "y": "cLTEJdCaq3L0Z6sj1C0_5vey-8zLhQawTv9ee9hbRog",
    "d": "dIuvYBAUSS4IDA2YHauMJfEXy0zkBDoulUZRF50HTVQ"
  }
};

export const rogueAgentKey: DemoKey = {
  "keyId": "key:agent:s4HO0qIea7FDhjky",
  "subject": "ROGUE-Agent-99, unregistered agent",
  "role": "agent",
  "publicKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "ef3x3YownYAVqF5hdKLrBVt0KBLCbv5os8O2JGs4QXw",
    "y": "gbS5h1khvPnLHew60FTXvZyEYFkbXvIWrvLS3FzomVE"
  },
  "privateKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "ef3x3YownYAVqF5hdKLrBVt0KBLCbv5os8O2JGs4QXw",
    "y": "gbS5h1khvPnLHew60FTXvZyEYFkbXvIWrvLS3FzomVE",
    "d": "501BPowcgqPbTpe0XL6qcQtga7aURJLLtJlLZG4qcPs"
  }
};

export const gateKey: DemoKey = {
  "keyId": "key:gate:bP6EgqaO3BC-K-zS",
  "subject": "Warrant Gate (demonstration instance)",
  "role": "gate",
  "publicKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "8Isg2Vgj7WdcczrM0NDPMy7w8vISS2Ysr7obLoCaCB0",
    "y": "AWMc8bRhTYGAK0Y8Oy7MGrJFv0InjLLWogWuwBAjFlo"
  },
  "privateKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "8Isg2Vgj7WdcczrM0NDPMy7w8vISS2Ysr7obLoCaCB0",
    "y": "AWMc8bRhTYGAK0Y8Oy7MGrJFv0InjLLWogWuwBAjFlo",
    "d": "abBLylr6YauhblA4Rx1QgCre9ZRQUdfC0YeDTaho4PA"
  }
};

export const ledgerKey: DemoKey = {
  "keyId": "key:ledger:y2rsuX03fq8Bb7om",
  "subject": "Warrant recording service (demonstration instance)",
  "role": "ledger",
  "publicKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "3x0hkE9p18YbspgopuCAjnIQXJEbBL44-7QQSUHH2Aw",
    "y": "qx_r9e57H9fW6BJV5caGaoX1_HZSum1MwQ91UtJFT4k"
  },
  "privateKeyJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "3x0hkE9p18YbspgopuCAjnIQXJEbBL44-7QQSUHH2Aw",
    "y": "qx_r9e57H9fW6BJV5caGaoX1_HZSum1MwQ91UtJFT4k",
    "d": "LGB6IKxIJCpkExhLrLyQa5v9slDs-QXA7cdSUXx62V4"
  }
};

export const demoKeys: DemoKey[] = [principalKey, apAgentKey, payAgentKey, settleAgentKey, rogueAgentKey, gateKey, ledgerKey];
