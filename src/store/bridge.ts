import map from 'lodash/fp/map'
import flatMap from 'lodash/fp/flatMap'
import fromPairs from 'lodash/fp/fromPairs'
import flow from 'lodash/fp/flow'
import concat from 'lodash/fp/concat'
import {
  FPNumber,
  BridgeApprovedRequest,
  BridgeCurrencyType,
  BridgeTxStatus,
  BridgeRequest,
  Operation,
  BridgeHistory,
  TransactionStatus,
  KnownAssets,
  RequestType
} from '@sora-substrate/util'
import { api } from '@soramitsu/soraneo-wallet-web'

import { STATES } from '@/utils/fsm'
import web3Util, { ABI, KnownBridgeAsset, OtherContractType } from '@/utils/web3-util'
import { delay, isXorAccountAsset } from '@/utils'
import { EthereumGasLimits, MaxUint256, MetamaskCancellationCode } from '@/consts'
import { Transaction } from 'web3-core'

const SORA_REQUESTS_TIMEOUT = 5 * 1000

const types = flow(
  flatMap(x => [x + '_REQUEST', x + '_SUCCESS', x + '_FAILURE']),
  concat([
    'SET_SORA_TO_ETHEREUM',
    'SET_ASSET_ADDRESS',
    'SET_AMOUNT',
    'SET_SORA_TOTAL',
    'SET_ETHEREUM_TOTAL',
    'SET_TRANSACTION_CONFIRM',
    'SET_SORA_TRANSACTION_HASH',
    'SET_SORA_TRANSACTION_DATE',
    'SET_ETHEREUM_TRANSACTION_HASH',
    'SET_ETHEREUM_TRANSACTION_DATE',
    'SET_INITIAL_TRANSACTION_STATE',
    'SET_CURRENT_TRANSACTION_STATE',
    'SET_TRANSACTION_STEP',
    'SET_HISTORY_ITEM'
  ]),
  map(x => [x, x]),
  fromPairs
)([
  'GET_HISTORY',
  'GET_SORA_NETWORK_FEE',
  'GET_ETHEREUM_NETWORK_FEE',
  'SIGN_SORA_TRANSACTION_SORA_ETH',
  'SIGN_ETH_TRANSACTION_SORA_ETH',
  'SEND_SORA_TRANSACTION_SORA_ETH',
  'SEND_ETH_TRANSACTION_SORA_ETH',
  'SIGN_SORA_TRANSACTION_ETH_SORA',
  'SIGN_ETH_TRANSACTION_ETH_SORA',
  'SEND_SORA_TRANSACTION_ETH_SORA',
  'SEND_ETH_TRANSACTION_ETH_SORA'
])

async function waitForApprovedRequest (hash: string): Promise<BridgeApprovedRequest> {
  await delay(SORA_REQUESTS_TIMEOUT)
  const approvedRequest = await api.bridge.getApprovedRequest(hash)
  if (approvedRequest) {
    // If Completed -> Done
    // TODO: Check if this is a place with result of signing
    return approvedRequest
  }
  const request = await api.bridge.getRequest(hash)
  if (!request) {
    return await waitForApprovedRequest(hash)
  }
  if ([BridgeTxStatus.Failed, BridgeTxStatus.Frozen].includes(request.status)) {
    // Set SORA_REJECTED
    throw new Error('Transaction was failed or canceled')
  }
  return await waitForApprovedRequest(hash)
  // Sora Pending
}

async function waitForEthereumTransactionStatus (hash: string): Promise<Transaction> {
  const web3 = await web3Util.getInstance()
  const result = await web3.eth.getTransaction(hash)
  if (result.blockNumber === null) {
    await delay(SORA_REQUESTS_TIMEOUT)
    return waitForEthereumTransactionStatus(hash)
  }
  return result
}

async function waitForRequest (hash: string): Promise<BridgeRequest> {
  await delay(SORA_REQUESTS_TIMEOUT)
  const request = await api.bridge.getRequest(hash)
  if (!request) {
    return await waitForRequest(hash)
  }
  switch (request.status) {
    case BridgeTxStatus.Failed:
    case BridgeTxStatus.Frozen:
      throw new Error('Transaction was failed or canceled')
    case BridgeTxStatus.Done:
      return request
  }
  return await waitForRequest(hash)
}

async function waitForExtrinsicFinalization (id?: string): Promise<BridgeHistory> {
  if (!id) {
    console.error("Can't find history id")
    throw new Error('History id error')
  }
  const tx = api.bridge.getHistory(id)
  if (tx && tx.status === TransactionStatus.Error) {
    throw new Error(tx.errorMessage)
  }
  if (!tx || tx.status !== TransactionStatus.Finalized) {
    await delay(250)
    return await waitForExtrinsicFinalization(id)
  }
  return tx
}

function initialState () {
  return {
    isSoraToEthereum: true,
    assetAddress: '',
    amount: '',
    soraNetworkFee: 0,
    ethereumNetworkFee: 0,
    soraTotal: 0,
    ethereumTotal: 0,
    isTransactionConfirmed: false,
    soraTransactionHash: '',
    ethereumTransactionHash: '',
    soraTransactionDate: '',
    ethereumTransactionDate: '',
    initialTransactionState: STATES.INITIAL,
    currentTransactionState: STATES.INITIAL,
    transactionStep: 1,
    history: [],
    historyItem: null
  }
}

const state = initialState()

const getters = {
  isSoraToEthereum (state) {
    return state.isSoraToEthereum
  },
  asset (state, getters, rootState, rootGetters) {
    return rootGetters['assets/getAssetDataByAddress'](state.assetAddress)
  },
  amount (state) {
    return state.amount
  },
  soraNetworkFee (state) {
    return state.soraNetworkFee
  },
  ethereumNetworkFee (state) {
    return state.ethereumNetworkFee
  },
  soraTotal (state) {
    return state.soraTotal
  },
  ethereumTotal (state) {
    return state.ethereumTotal
  },
  isTransactionConfirmed (state) {
    return state.isTransactionConfirmed
  },
  soraTransactionHash (state) {
    return state.soraTransactionHash
  },
  ethereumTransactionHash (state) {
    return state.ethereumTransactionHash
  },
  soraTransactionDate (state) {
    return state.soraTransactionDate
  },
  ethereumTransactionDate (state) {
    return state.ethereumTransactionDate
  },
  initialTransactionState (state) {
    return state.initialTransactionState
  },
  currentTransactionState (state) {
    return state.currentTransactionState
  },
  transactionStep (state) {
    return state.transactionStep
  },
  history (state) {
    return state.history
  },
  historyItem (state) {
    return state.historyItem
  }
}

const mutations = {
  [types.SET_SORA_TO_ETHEREUM] (state, isSoraToEthereum: boolean) {
    state.isSoraToEthereum = isSoraToEthereum
  },
  [types.SET_ASSET_ADDRESS] (state, address: string) {
    state.assetAddress = address
  },
  [types.SET_AMOUNT] (state, amount: string) {
    state.amount = amount
  },
  [types.GET_SORA_NETWORK_FEE_REQUEST] (state) {
  },
  [types.GET_SORA_NETWORK_FEE_SUCCESS] (state, fee) {
    state.soraNetworkFee = fee
  },
  [types.GET_SORA_NETWORK_FEE_FAILURE] (state) {
    state.soraNetworkFee = ''
  },
  [types.GET_ETHEREUM_NETWORK_FEE_REQUEST] (state) {
  },
  [types.GET_ETHEREUM_NETWORK_FEE_SUCCESS] (state, fee: string | number) {
    state.ethereumNetworkFee = fee
  },
  [types.GET_ETHEREUM_NETWORK_FEE_FAILURE] (state) {
    state.ethereumNetworkFee = ''
  },
  [types.SET_SORA_TOTAL] (state, soraTotal: string | number) {
    state.soraTotal = soraTotal
  },
  [types.SET_ETHEREUM_TOTAL] (state, ethereumTotal: string | number) {
    state.ethereumTotal = ethereumTotal
  },
  [types.SET_TRANSACTION_CONFIRM] (state, isTransactionConfirmed: boolean) {
    state.isTransactionConfirmed = isTransactionConfirmed
  },
  [types.SET_SORA_TRANSACTION_HASH] (state, soraTransactionHash: string) {
    state.soraTransactionHash = soraTransactionHash
  },
  [types.SET_ETHEREUM_TRANSACTION_HASH] (state, ethereumTransactionHash: string) {
    state.ethereumTransactionHash = ethereumTransactionHash
  },
  [types.SET_SORA_TRANSACTION_DATE] (state, soraTransactionDate: string) {
    state.soraTransactionDate = soraTransactionDate
  },
  [types.SET_ETHEREUM_TRANSACTION_DATE] (state, ethereumTransactionDate: string) {
    state.ethereumTransactionDate = ethereumTransactionDate
  },
  [types.SET_CURRENT_TRANSACTION_STATE] (state, currentTransactionState: STATES) {
    state.currentTransactionState = currentTransactionState
  },
  [types.SET_INITIAL_TRANSACTION_STATE] (state, initialTransactionState: STATES) {
    state.initialTransactionState = initialTransactionState
  },
  [types.SET_TRANSACTION_STEP] (state, transactionStep: number) {
    state.transactionStep = transactionStep
  },
  [types.GET_HISTORY_REQUEST] (state) {
    state.history = null
  },
  [types.GET_HISTORY_SUCCESS] (state, history: Array<BridgeHistory>) {
    state.history = history
  },
  [types.GET_HISTORY_FAILURE] (state) {
    state.history = null
  },
  [types.SET_HISTORY_ITEM] (state, historyItem: BridgeHistory | null) {
    state.historyItem = historyItem
  },
  [types.SIGN_SORA_TRANSACTION_SORA_ETH_REQUEST] (state) {},
  [types.SIGN_SORA_TRANSACTION_SORA_ETH_SUCCESS] (state) {},
  [types.SIGN_SORA_TRANSACTION_SORA_ETH_FAILURE] (state) {},
  [types.SIGN_ETH_TRANSACTION_SORA_ETH_REQUEST] (state) {},
  [types.SIGN_ETH_TRANSACTION_SORA_ETH_SUCCESS] (state) {},
  [types.SIGN_ETH_TRANSACTION_SORA_ETH_FAILURE] (state) {},
  [types.SEND_SORA_TRANSACTION_SORA_ETH_REQUEST] (state) {},
  [types.SEND_SORA_TRANSACTION_SORA_ETH_SUCCESS] (state) {},
  [types.SEND_SORA_TRANSACTION_SORA_ETH_FAILURE] (state) {},
  [types.SEND_ETH_TRANSACTION_SORA_ETH_REQUEST] (state) {},
  [types.SEND_ETH_TRANSACTION_SORA_ETH_SUCCESS] (state) {},
  [types.SEND_ETH_TRANSACTION_SORA_ETH_FAILURE] (state) {},
  [types.SIGN_SORA_TRANSACTION_ETH_SORA_REQUEST] (state) {},
  [types.SIGN_SORA_TRANSACTION_ETH_SORA_SUCCESS] (state) {},
  [types.SIGN_SORA_TRANSACTION_ETH_SORA_FAILURE] (state) {},
  [types.SIGN_ETH_TRANSACTION_ETH_SORA_REQUEST] (state) {},
  [types.SIGN_ETH_TRANSACTION_ETH_SORA_SUCCESS] (state) {},
  [types.SIGN_ETH_TRANSACTION_ETH_SORA_FAILURE] (state) {},
  [types.SEND_SORA_TRANSACTION_ETH_SORA_REQUEST] (state) {},
  [types.SEND_SORA_TRANSACTION_ETH_SORA_SUCCESS] (state) {},
  [types.SEND_SORA_TRANSACTION_ETH_SORA_FAILURE] (state) {},
  [types.SEND_ETH_TRANSACTION_ETH_SORA_REQUEST] (state) {},
  [types.SEND_ETH_TRANSACTION_ETH_SORA_SUCCESS] (state) {},
  [types.SEND_ETH_TRANSACTION_ETH_SORA_FAILURE] (state) {}
}

const actions = {
  setSoraToEthereum ({ commit }, isSoraToEthereum: boolean) {
    commit(types.SET_SORA_TO_ETHEREUM, isSoraToEthereum)
  },
  setAssetAddress ({ commit }, address?: string) {
    commit(types.SET_ASSET_ADDRESS, address)
  },
  setAmount ({ commit }, amount: string) {
    commit(types.SET_AMOUNT, amount)
  },
  setSoraNetworkFee ({ commit }, soraNetworkFee: string) {
    commit(types.GET_SORA_NETWORK_FEE_SUCCESS, soraNetworkFee)
  },
  setEthereumNetworkFee ({ commit }, ethereumNetworkFee: string) {
    commit(types.GET_ETHEREUM_NETWORK_FEE_SUCCESS, ethereumNetworkFee)
  },
  getSoraTotal ({ commit }, soraTotal: string | number) {
    commit(types.SET_SORA_TOTAL, soraTotal)
  },
  getEthereumTotal ({ commit }, ethereumTotal: string | number) {
    commit(types.SET_ETHEREUM_TOTAL, ethereumTotal)
  },
  setTransactionConfirm ({ commit }, isTransactionConfirmed: boolean) {
    commit(types.SET_TRANSACTION_CONFIRM, isTransactionConfirmed)
  },
  setSoraTransactionHash ({ commit }, soraTransactionHash: string) {
    commit(types.SET_SORA_TRANSACTION_HASH, soraTransactionHash)
  },
  setEthereumTransactionHash ({ commit }, ethereumTransactionHash: string) {
    commit(types.SET_ETHEREUM_TRANSACTION_HASH, ethereumTransactionHash)
  },
  setSoraTransactionDate ({ commit }, soraTransactionDate: string) {
    commit(types.SET_SORA_TRANSACTION_DATE, soraTransactionDate)
  },
  setEthereumTransactionDate ({ commit }, ethereumTransactionDate: string) {
    commit(types.SET_ETHEREUM_TRANSACTION_DATE, ethereumTransactionDate)
  },
  setCurrentTransactionState ({ commit }, currentTransactionState: STATES) {
    commit(types.SET_CURRENT_TRANSACTION_STATE, currentTransactionState)
  },
  setInitialTransactionState ({ commit }, initialTransactionState: STATES) {
    commit(types.SET_INITIAL_TRANSACTION_STATE, initialTransactionState)
  },
  setTransactionStep ({ commit }, transactionStep: number) {
    commit(types.SET_TRANSACTION_STEP, transactionStep)
  },
  resetBridgeForm ({ dispatch }, withAddress = false) {
    if (!withAddress) {
      dispatch('setAssetAddress', '')
    }
    dispatch('setSoraToEthereum', true)
    dispatch('setTransactionConfirm', false)
    dispatch('setCurrentTransactionState', STATES.INITIAL)
    dispatch('setSoraTransactionDate', '')
    dispatch('setSoraTransactionHash', '')
    dispatch('setEthereumTransactionDate', '')
    dispatch('setEthereumTransactionHash', '')
  },
  async getHistory ({ commit }) {
    commit(types.GET_HISTORY_REQUEST)
    try {
      commit(types.GET_HISTORY_SUCCESS, api.bridge.accountHistory)
    } catch (error) {
      commit(types.GET_HISTORY_FAILURE)
      throw error
    }
  },
  setHistoryItem ({ commit }, historyItem: BridgeHistory | null) {
    commit(types.SET_HISTORY_ITEM, historyItem)
  },
  saveHistory ({ commit }, history: BridgeHistory) {
    api.saveHistory(history)
  },
  clearHistory ({ commit }) {
    api.bridge.clearHistory()
    commit(types.GET_HISTORY_SUCCESS, [])
  },
  findRegisteredAsset ({ commit, getters, rootGetters }) {
    return rootGetters['assets/registeredAssets'].find(item => item.address === getters.asset.address)
  },
  async getNetworkFee ({ commit, getters, dispatch }) {
    if (!getters.asset || !getters.asset.address) {
      return
    }
    commit(types.GET_SORA_NETWORK_FEE_REQUEST)
    try {
      const asset = await dispatch('findRegisteredAsset')
      // TODO: use it
      // const transferType = isXorAccountAsset(getters.asset) ? RequestType.TransferXOR : RequestType.Transfer
      const fee = await (
        getters.isSoraToEthereum
          ? api.bridge.getTransferToEthFee(asset, '', getters.amount)
          : api.bridge.getRequestFromEthFee('' /* , transferType */)
      )
      commit(types.GET_SORA_NETWORK_FEE_SUCCESS, fee)
    } catch (error) {
      console.error(error)
      commit(types.GET_SORA_NETWORK_FEE_FAILURE)
    }
  },
  async getEthNetworkFee ({ commit, getters }) {
    if (!getters.asset || !getters.asset.address) {
      return
    }
    commit(types.GET_ETHEREUM_NETWORK_FEE_REQUEST)
    try {
      const web3 = await web3Util.getInstance()
      const gasPrice = +(await web3.eth.getGasPrice())
      const knownAsset = KnownAssets.get(getters.asset.address)
      const gasLimit = EthereumGasLimits[+getters.isSoraToEthereum][knownAsset ? getters.asset.symbol : KnownBridgeAsset.Other]
      const fee = gasPrice * gasLimit
      commit(types.GET_ETHEREUM_NETWORK_FEE_SUCCESS, web3.utils.fromWei(`${fee}`, 'ether'))
    } catch (error) {
      console.error(error)
      commit(types.GET_ETHEREUM_NETWORK_FEE_FAILURE)
    }
  },
  async generateHistoryItem ({ commit, getters, dispatch }, playground) {
    await dispatch('setHistoryItem', api.bridge.generateHistoryItem({
      type: getters.isSoraToEthereum ? Operation.EthBridgeOutgoing : Operation.EthBridgeIncoming,
      amount: getters.amount,
      symbol: getters.asset.symbol,
      assetAddress: getters.asset.address,
      startTime: playground.date,
      endTime: playground.date,
      signed: false,
      status: '',
      transactionStep: playground.step,
      hash: '',
      ethereumHash: '',
      transactionState: STATES.INITIAL,
      soraNetworkFee: getters.soraNetworkFee.toString(),
      ethereumNetworkFee: getters.ethereumNetworkFee.toString()
    }))
    return getters.historyItem
  },
  async updateHistoryParams ({ commit, dispatch }, params) {
    await dispatch('saveHistory', params.tx)
    await dispatch('setHistoryItem', params.tx)
    if (!params.isEndTimeOnly) {
      await dispatch('setSoraTransactionDate', params.tx.startTime)
    }
    await dispatch('setEthereumTransactionDate', params.tx.endTime)
  },
  async signSoraTransactionSoraToEth ({ commit, getters, rootGetters, dispatch }, { txId }) {
    if (!getters.asset || !getters.asset.address || !getters.amount || !getters.isSoraToEthereum) {
      return
    }
    const asset = await dispatch('findRegisteredAsset')
    // TODO: asset should be registered just for now
    if (!asset) {
      return
    }
    commit(types.SIGN_SORA_TRANSACTION_SORA_ETH_REQUEST)
    try {
      const ethAccount = rootGetters['web3/ethAddress']
      await api.bridge.transferToEth(asset, ethAccount, getters.amount, txId)
      commit(types.SIGN_SORA_TRANSACTION_SORA_ETH_SUCCESS)
    } catch (error) {
      commit(types.SIGN_SORA_TRANSACTION_SORA_ETH_FAILURE)
      throw new Error(error.message)
    }
  },
  async signEthTransactionSoraToEth ({ commit, getters, rootGetters, dispatch }, { hash }) {
    if (!getters.asset || !getters.asset.address || !getters.amount || !getters.isSoraToEthereum) {
      return
    }
    const asset = await dispatch('findRegisteredAsset')
    // TODO: asset should be registered just for now
    if (!asset) {
      return
    }
    commit(types.SIGN_ETH_TRANSACTION_SORA_ETH_REQUEST)

    try {
      const request = await waitForApprovedRequest(hash) // If it causes an error, then -> catch -> SORA_REJECTED
      const web3 = await web3Util.getInstance()

      if (!rootGetters['web3/isValidEthNetwork']) {
        throw new Error('Change eth network in Metamask')
      }
      const symbol = getters.asset.symbol
      const ethAccount = rootGetters['web3/ethAddress']
      const isValOrXor = [KnownBridgeAsset.XOR, KnownBridgeAsset.VAL].includes(symbol)
      const contract = isValOrXor
        ? rootGetters[`web3/contract${symbol}`]
        : rootGetters[`web3/contract${KnownBridgeAsset.Other}`][OtherContractType.Bridge]
      const contractInstance = new web3.eth.Contract(contract.abi)
      const contractAddress = rootGetters[`web3/address${isValOrXor ? symbol : KnownBridgeAsset.Other}`]
      contractInstance.options.address = contractAddress.MASTER
      const method = isValOrXor
        ? 'mintTokensByPeers'
        : request.currencyType === BridgeCurrencyType.TokenAddress
          ? 'receiveByEthereumAssetAddress'
          : 'receiveBySidechainAssetId'
      const methodArgs = [
        (isValOrXor || request.currencyType === BridgeCurrencyType.TokenAddress)
          ? asset.externalAddress // address tokenAddress OR
          : asset.address, // bytes32 assetId
        new FPNumber(getters.amount, asset.decimals).toCodecString(), // uint256 amount
        ethAccount // address beneficiary
      ]
      methodArgs.push(...(isValOrXor
        ? [
          hash, // bytes32 txHash
          request.v, // uint8[] memory v
          request.r, // bytes32[] memory r
          request.s, // bytes32[] memory s
          request.from // address from
        ] : [
          request.from, // address from
          hash, // bytes32 txHash
          request.v, // uint8[] memory v
          request.r, // bytes32[] memory r
          request.s // bytes32[] memory s
        ])
      )
      const contractMethod = contractInstance.methods[method](...methodArgs)
      const gas = await contractMethod.estimateGas()
      return new Promise((resolve, reject) => {
        contractMethod.send({ gas, from: ethAccount })
          .on('transactionHash', hash => {
            commit(types.SIGN_ETH_TRANSACTION_SORA_ETH_SUCCESS)
            resolve(hash)
          })
      })
    } catch (error) {
      commit(types.SIGN_ETH_TRANSACTION_SORA_ETH_FAILURE)
      throw error
    }
  },
  async sendSoraTransactionSoraToEth ({ commit, getters, rootGetters, dispatch }, { txId }) {
    commit(types.SEND_SORA_TRANSACTION_SORA_ETH_REQUEST)
    try {
      const tx = await waitForExtrinsicFinalization(txId)
      commit(types.SEND_SORA_TRANSACTION_SORA_ETH_SUCCESS)
      return tx.hash
    } catch (error) {
      commit(types.SEND_SORA_TRANSACTION_SORA_ETH_FAILURE)
      throw error
    }
  },
  async sendEthTransactionSoraToEth ({ commit, getters, rootGetters, dispatch }, { ethereumHash }) {
    commit(types.SEND_ETH_TRANSACTION_SORA_ETH_REQUEST)
    try {
      await waitForEthereumTransactionStatus(ethereumHash)
      commit(types.SEND_ETH_TRANSACTION_SORA_ETH_SUCCESS)
    } catch (error) {
      commit(types.SEND_ETH_TRANSACTION_SORA_ETH_FAILURE)
      throw error
    }
  },
  async signEthTransactionEthToSora ({ commit, getters, rootGetters, dispatch }) {
    if (!getters.asset || !getters.asset.address || !getters.amount || getters.isSoraToEthereum) {
      return
    }
    const asset = await dispatch('findRegisteredAsset')
    // TODO: asset should be registered for now (ERC-20 tokens flow)
    if (!asset) {
      return
    }
    commit(types.SIGN_ETH_TRANSACTION_ETH_SORA_REQUEST)

    try {
      if (!rootGetters['web3/isValidEthNetwork']) {
        throw new Error('Change eth network in Metamask')
      }
      const contract = rootGetters[`web3/contract${KnownBridgeAsset.Other}`]
      const ethAccount = rootGetters['web3/ethAddress']
      const isExternalAccountConnected = await web3Util.checkAccountIsConnected(ethAccount)
      if (!isExternalAccountConnected) {
        await dispatch('web3/disconnectExternalAccount', {}, { root: true })
        throw new Error('Connect account in Metamask')
      }
      const web3 = await web3Util.getInstance()
      const contractAddress = rootGetters[`web3/address${KnownBridgeAsset.Other}`]
      const allowance = await dispatch('web3/getAllowanceByEthAddress', { address: asset.externalAddress }, { root: true })
      if (FPNumber.lte(new FPNumber(allowance), new FPNumber(getters.amount))) {
        const tokenInstance = new web3.eth.Contract(contract[OtherContractType.ERC20].abi)
        tokenInstance.options.address = asset.externalAddress
        const methodArgs = [
          contractAddress.MASTER, // address spender
          MaxUint256 // uint256 amount
        ]
        const approveMethod = tokenInstance.methods.approve(...methodArgs)
        await approveMethod.send({ from: ethAccount })
      }
      const soraAccountAddress = rootGetters.account.address
      const accountId = await web3Util.accountAddressToHex(soraAccountAddress)
      const contractInstance = new web3.eth.Contract(contract[OtherContractType.Bridge].abi)
      contractInstance.options.address = contractAddress.MASTER
      const tokenInstance = new web3.eth.Contract(ABI.balance as any)
      tokenInstance.options.address = asset.externalAddress
      const decimalsMethod = tokenInstance.methods.decimals()
      const decimals = await decimalsMethod.call()
      const methodArgs = [
        accountId, // bytes32 to
        new FPNumber(getters.amount, +decimals).toCodecString(), // uint256 amount
        asset.externalAddress // address tokenAddress
      ]
      const contractMethod = contractInstance.methods.sendERC20ToSidechain(...methodArgs)

      return new Promise((resolve, reject) => {
        contractMethod.send({ from: ethAccount })
          .on('transactionHash', hash => {
            commit(types.SIGN_ETH_TRANSACTION_ETH_SORA_SUCCESS)
            resolve(hash)
          })
      })
    } catch (error) {
      // if (error.code === MetamaskCancellationCode && currentHistoryItem.id) {
      //   api.bridge.removeHistory(currentHistoryItem.id)
      // } else {
      //   await dispatch('updateHistoryParams', { tx: currentHistoryItem, isEndTimeOnly: true })
      // }
      commit(types.SIGN_ETH_TRANSACTION_ETH_SORA_FAILURE)
      console.error(error)
      throw new Error(error.message)
    }
  },
  async sendEthTransactionEthToSora ({ commit, getters, rootGetters, dispatch }, { ethereumHash }) {
    commit(types.SEND_ETH_TRANSACTION_SORA_ETH_REQUEST)
    try {
      await waitForEthereumTransactionStatus(ethereumHash)
      commit(types.SEND_ETH_TRANSACTION_SORA_ETH_SUCCESS)
    } catch (error) {
      commit(types.SEND_ETH_TRANSACTION_SORA_ETH_FAILURE)
      throw error
    }
  },
  async signSoraTransactionEthToSora ({ commit, getters, rootGetters, dispatch }, { ethereumHash }) {
    if (!getters.asset || !getters.asset.address || !getters.amount || getters.isSoraToEthereum || !getters.ethereumTransactionHash) {
      return
    }
    const asset = await dispatch('findRegisteredAsset')
    // TODO: asset should be registered just for now
    if (!asset) {
      return
    }
    commit(types.SIGN_SORA_TRANSACTION_ETH_SORA_REQUEST)

    try {
      // TODO: use it
      // const transferType = isXorAccountAsset(getters.asset) ? RequestType.TransferXOR : RequestType.Transfer
      await api.bridge.requestFromEth(ethereumHash /* , transferType */)
      commit(types.SIGN_SORA_TRANSACTION_ETH_SORA_SUCCESS)
    } catch (error) {
      commit(types.SIGN_SORA_TRANSACTION_ETH_SORA_FAILURE)
      console.error(error)
      throw new Error(error.message)
    }
  },
  async sendSoraTransactionEthToSora ({ commit, getters, rootGetters, dispatch }, { ethereumHash }) {
    commit(types.SEND_SORA_TRANSACTION_ETH_SORA_REQUEST)
    try {
      await waitForRequest(ethereumHash)
      commit(types.SEND_SORA_TRANSACTION_ETH_SORA_SUCCESS)
    } catch (error) {
      commit(types.SEND_SORA_TRANSACTION_ETH_SORA_FAILURE)
      console.error(error)
      throw new Error(error.message)
    }
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
