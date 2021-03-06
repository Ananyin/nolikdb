import { action, observable, toJS } from 'mobx';
import axios from 'axios';
import { keyPair, signBytes, randomSeed } from '@waves/ts-lib-crypto';
import getConfig from 'next/config';
import { sha256 } from 'js-sha256';
// import * as moment from 'moment';

const { publicRuntimeConfig } = getConfig();
const { API_HOST, CLIENT_SEED, SPONSOR_HOST, ROOT_SEED } = publicRuntimeConfig;

class CdmStore {
  stores = null;
  constructor(stores) {
    this.stores = stores;
    this.toggleWithCrypto = this.toggleWithCrypto.bind(this);
    this.sendCdm = this.sendCdm.bind(this);
    this.sendNewCdm = this.sendNewCdm.bind(this);
    this.sendThreadCdm = this.sendThreadCdm.bind(this);
    this.sendAddMembersCdm = this.sendAddMembersCdm.bind(this);
  }

  @observable withCrypto = [];
  @observable sendCdmStatus = 'init';
  @observable cdmData = null;

  @action
  toggleWithCrypto(txId) {
    const { withCrypto } = this;
    const index = withCrypto.indexOf(txId);
    if (index < 0) {
      withCrypto.push(txId);
    } else {
      withCrypto.splice(index, 1);
    }
    this.withCrypto = withCrypto;
  }

  @action
  sendNewCdm() {
    this.newCdm();
    this.sendCdm();
  }

  @action
  sendThreadCdm() {
    const { threads, notifiers } = this.stores;

    if (!threads.current) {
      notifiers.error('Thread is not selected');
      return;
    }

    this.replyToThread();
    this.sendCdm();
  }

  @action
  sendQuery() {
    this.newQuery();
  }

  @action
  sendAddMembersCdm() {
    const { threads, notifiers } = this.stores;

    if (!threads.current) {
      notifiers.error('Thread is not selected');
      return;
    }

    this.addMembers();
    this.sendCdm();
  }

  @action
  sendCdm() {
    const { notifiers, crypto, index } = this.stores;
    if (this.sendCdmStatus === 'pending') {
      notifiers.warning('Senging in progress. Please wait...');
      return;
    }

    if (this.cdmData === null) return;

    if (index.query.trim() === '') {
      notifiers.error(`Message can't be empty`);
      return;
    }

    this.sendCdmStatus = 'pending';
    const cdm = crypto.compose(this.cdmData);
    // console.log(cdm);
    // return;

    const ipfsFormConfig = {};
    const ipfsFormData = new FormData();
    ipfsFormData.append('data', cdm);
    axios
      .post(`${API_HOST}/api/v1/ipfs`, ipfsFormData, ipfsFormConfig)
      .then(ipfsData => {
        const keys = keyPair(CLIENT_SEED);
        const bytes = Uint8Array.from(keys.publicKey);
        const signature = signBytes(keys, bytes);

        const sponsorFormData = new FormData();
        sponsorFormData.append('signature', signature);
        sponsorFormData.append('ipfsHash', ipfsData.data.Hash);
        const formConfig = {};
        axios
          .post(`${SPONSOR_HOST}/sponsor`, sponsorFormData, formConfig)
          .then(() => {
            notifiers.success('Query has been sent.');
            this.sendCdmStatus = 'success';
          })
          .catch(e => {
            console.log('err', e);
            this.sendCdmStatus = 'error';
          });
      });
  }

  @action
  newQuery() {
    const { app, index, crypto } = this.stores;

    let cdm = null;
    const isCreate = index.query
      .replace(';', '')
      .match(/^CREATE\s*TABLE\s*\w*\(.*\)$/gm);
    const isInsert = index.query
      .replace(';', '')
      .match(/^INSERT\s*INTO\s*\w*\(.*\)\s*VALUES\(.*\)$/gm);

    const isSelect = index.query
      .replace(';', '')
      .match(/^(?:.*)FROM(?:\s*)(.*)$/gm);

    if (isCreate) {
      const creation = index.query.replace(/^(?:.*)TABLE(?:\s*)/gm, '');
      const table = creation.match(/^.*(?=\()/gm);
      const columns = creation
        .replace(table, '')
        .replace(/[()]/gm, '')
        .split(',')
        .map(el => ({
          name: el.trim(),
          seed: randomSeed(),
        }));

      cdm = {
        create: {
          table: table[0],
          columns,
        },
        senders: [ROOT_SEED],
      };

      this.cdmData = [cdm];
      this.sendCdm();
    }

    if (isInsert) {
      const regex = /^(?:.*)INTO(?:\s*)(\w*)(\(.*\))\s*VALUES(\(.*\))$/gm;
      const m = regex.exec(index.query.replace(';', ''));
      const table = m[1];

      index.getColumns().then(res => {
        const columns = m[2]
          .replace(/[()]/gm, '')
          .split(',')
          .map(el => el.trim());

        // console.log('columns', columns);

        const values = m[3]
          .replace(/[()]/gm, '')
          .split(',')
          .map(el => el.trim());

        const data = [];
        for (let i = 0; i < res.length; i += 1) {
          if (
            columns.indexOf(res[i].columnName) > -1 &&
            table === res[i].tableName
          ) {
            data.push({
              column: {
                name: res[i].columnName,
                hash: res[i].columnHash,
                ciphertext: res[i].columnCiphertext,
              },
              table: {
                name: res[i].tableName,
                hash: res[i].tableHash,
                ciphertext: res[i].tableCiphertext,
              },
              value: values[i],
            });
          }
        }

        cdm = {
          table,
          insert: {
            table,
            data,
          },
          senders: [ROOT_SEED],
        };
        console.log(cdm);
        this.cdmData = [cdm];
        this.sendCdm();
      });
    }

    if (isSelect) {
      const { index } = this.stores;
      const regex = /^(?:.*)FROM(?:\s*)(.*)/gm;
      const m = regex.exec(index.query.replace(';', ''));
      const table = m[1];

      // const list = [];
      index.getValues().then(res => {
        console.log(res);
        index.list = res;
      });
    }
  }

  @action
  newCdm() {
    const { app, chat, crypto } = this.stores;

    const rawSubject = crypto.randomize(chat.subject) || '';
    const rawMessage = crypto.randomize(chat.message) || '';

    const keys = keyPair(app.seed);
    const bytes = Uint8Array.from(
      sha256(
        `${rawSubject ? sha256(rawSubject) : ''}${
          rawMessage ? sha256(rawMessage) : ''
        }`,
      ),
    );

    const cdm = {
      subject: chat.subject.trim(),
      message: chat.message.trim(),
      rawSubject,
      rawMessage,
      regarding: null,
      forwarded: null,
      recipients: chat.toRecipients.map(el => ({
        recipient: el,
        type: 'to',
        signature: signBytes(keys, bytes),
      })),
      from: {
        senderPublicKey: keys.publicKey,
      },
    };
    this.cdmData = [cdm];
  }

  @action
  replyToThread() {
    const { threads, chat, app, crypto } = this.stores;
    const initCdm = threads.current.cdms[0];

    const rawSubject = crypto.randomize(chat.subject) || '';
    const rawMessage = crypto.randomize(chat.message) || '';

    const keys = keyPair(app.seed);
    const bytes = Uint8Array.from(
      sha256(
        `${rawSubject ? sha256(rawSubject) : ''}${
          rawMessage ? sha256(rawMessage) : ''
        }`,
      ),
    );

    const re = {
      subject: chat.subject.trim(),
      message: chat.message.trim(),
      rawSubject,
      rawMessage,
      regarding: {
        reSubjectHash: initCdm.subjectHash,
        reMessageHash: initCdm.messageHash,
      },
      forwarded: null,
      recipients: threads.current.members.map(el => ({
        recipient: el,
        type: 'cc',
        signature: signBytes(keys, bytes),
      })),
      from: {
        senderPublicKey: keys.publicKey,
      },
    };

    this.cdmData = [re];
  }

  @action
  addMembers() {
    const { threads, chat, app, crypto } = this.stores;
    const data = [];
    const keys = keyPair(app.seed);

    const initCdm = threads.current.cdms[0];
    const fwdInitRawSubject = crypto.randomize(initCdm.subject);
    const fwdInitRawMessage = crypto.randomize(initCdm.message);

    const message = `Added new ${
      chat.newMembers.length > 1 ? 'members' : 'member'
    }: ${chat.newMembers.join(',')}`;
    const rawMessage = crypto.randomize(message) || '';

    const bytes = Uint8Array.from(
      sha256(`${rawMessage ? sha256(rawMessage) : ''}`),
    );

    const cdm = {
      subject: '',
      message,
      rawSubject: '',
      rawMessage,
      regarding: {
        reSubjectHash: sha256(fwdInitRawSubject),
        reMessageHash: sha256(fwdInitRawMessage),
      },
      forwarded: null,
      recipients: threads.current.members
        .map(el => ({
          recipient: el,
          type: 'to',
          signature: signBytes(keys, bytes),
        }))
        .concat(
          chat.newMembers.map(el => ({
            recipient: el,
            type: 'to',
            signature: signBytes(keys, bytes),
          })),
        ),
      from: {
        senderPublicKey: keys.publicKey,
      },
    };
    data.push(cdm);

    for (let i = 0; i < threads.current.cdms.length; i += 1) {
      const fwdCdm = threads.current.cdms[i];
      const fwdBytes = Uint8Array.from(
        sha256(
          `${fwdCdm.rawSubject ? sha256(fwdCdm.rawSubject) : ''}${
            fwdCdm.rawMessage ? sha256(fwdCdm.rawMessage) : ''
          }`,
        ),
      );

      const fwd = {
        subject: fwdCdm.subject,
        message: fwdCdm.message,
        rawSubject: fwdCdm.id === initCdm.id ? fwdInitRawSubject : null,
        rawMessage: fwdCdm.id === initCdm.id ? fwdInitRawMessage : null,
        regarding: {
          reSubjectHash:
            fwdCdm.id === initCdm.id ? null : sha256(fwdInitRawSubject),
          reMessageHash:
            fwdCdm.id === initCdm.id ? null : sha256(fwdInitRawMessage),
        },
        forwarded: {
          fwdSubjectHash: fwdCdm.subjectHash,
          fwdMessageHash: fwdCdm.messageHash,
        },
        recipients: threads.current.members
          .map(el => ({
            recipient: el,
            type: 'to',
            signature: signBytes(keys, fwdBytes),
          }))
          .concat(
            chat.newMembers.map(el => ({
              recipient: el,
              type: 'to',
              signature: signBytes(keys, fwdBytes),
            })),
          ),
        from: {
          senderPublicKey: keys.publicKey,
        },
      };
      data.push(fwd);
    }

    this.cdmData = data;
  }
}

export default CdmStore;
