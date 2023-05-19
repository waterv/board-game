const WebSocket = require('ws')
const wss = new WebSocket.Server({
  port: 1234,
})

const MIN_PLAYER = 2
const MAX_PLAYER = 7

const STATE = {
  CONNECT_SUCCESS: 200,
  REGIS_SUCCESS: 201,
  LOGIN_SUCCESS: 202,
  LOGOUT_SUCCESS: 203,
  FETCH_SUCCESS: 204,

  BROADCAST_GAME_START: 100,
  BROADCAST_GAME_BASIC: 101,
  BROADCAST_GAME_STATUS: 102,
  BROADCAST_GAME_END: 103,

  USER_NOT_EXIST: 0,

  REGIS_FAIL_USER_EXISTED: 1,
  REGIS_FAIL_GAME_STARTED: 2,
  REGIS_FAIL_ROOM_FULL: 3,

  READY_FAIL_GAME_STARTED: 10,

  ACT_FAIL_GAME_NOT_START: 20,
  ACT_FAIL_NOT_TURN: 21,
  ACT_FAIL_PILE_EXCEED: 22,
  ACT_FAIL_CARD_EXCEED: 23,
  ACT_FAIL_PILE_NOT_EXIST: 24,
  ACT_FAIL_CARD_NOT_EXIST: 25,
  ACT_FAIL_CARD_CANNOT_PUSH: 26,
  ACT_FAIL_PUSH_PICK_TOGETHER: 27,
  ACT_FAIL_TARGET_NOT_EXIST: 28,
  ACT_FAIL_TARGET_NO_BULL: 29,
  ACT_FAIL_BOTH_NOT_MAX_BULL: 30,

  LOGOUT_FAIL_GAME_STARTED: 40,
}

let started = false
let freeCards = []
let freeBull = 10
let round = 0
let turn = 0
let players = {}
let playerIds = []
let piles = []

let popCard = () => {
  if (freeCards.length == 0) return []
  let index = Math.floor(Math.random() * freeCards.length)
  return freeCards.splice(index, 1)
}

let canPushCard = (pile, card) => {
  if (pile.length == 0) return false
  let pileTop = pile[pile.length - 1]
  if (pileTop <= 90) return pileTop < card && card <= pileTop + 10
  return pileTop < card || card <= pileTop - 90
}

let scoreOfCard = card => {
  const primes = [
    2, 5, 7, 11, 17, 19, 29, 31, 37, 41, 47, 59, 61, 67, 71, 79, 89, 97,
  ]
  if ((card - 3) % 30 == 0) return 7
  if ((card - 3) % 10 == 0) return 5
  if (primes.includes(card)) return 3
  return 1
}

let scoreOfPlayer = player =>
  player.hand.reduce((sum, card) => sum + scoreOfCard(card), 0)

let register = data => {
  if (players[data.id] !== undefined) return STATE.REGIS_FAIL_USER_EXISTED
  if (started) return STATE.REGIS_FAIL_GAME_STARTED
  if (playerIds.length == MAX_PLAYER) return STATE.REGIS_FAIL_ROOM_FULL

  players[data.id] = {
    nickname: data.nickname,
    no: playerIds.length,
    ready: false,
    head: 0,
    bull: 0,
    hand: [],
  }
  playerIds.push(data.id)

  return {
    state: STATE.REGIS_SUCCESS,
    no: players[data.id].no,
  }
}

let login = data => {
  if (players[data.id] === undefined) return STATE.USER_NOT_EXIST

  return {
    state: STATE.LOGIN_SUCCESS,
    no: players[data.id].no,
    started,
  }
}

let ready = data => {
  if (players[data.id] === undefined) return STATE.USER_NOT_EXIST
  if (started) return STATE.READY_FAIL_GAME_STARTED

  players[data.id].ready = data.state
}

let logout = data => {
  if (players[data.id] === undefined) return STATE.USER_NOT_EXIST
  if (started) return STATE.LOGOUT_FAIL_GAME_STARTED

  delete players[data.id]
  let index = playerIds.indexOf(data.id)
  for (let i = index + 1; i < playerIds.length; i++)
    players[playerIds[i]].no -= 1
  playerIds.splice(index, 1)

  return STATE.LOGOUT_SUCCESS
}

let start = () => {
  started = true
  round += 1
  turn = 0
  freeCards = []
  for (let i = 1; i <= 100; i++) freeCards.push(i)
  freeBull = 10
  for (let player of Object.values(players)) {
    player.hand = []
    for (let i = 0; i < 10; i++) player.hand.push(popCard()[0])
    player.hand.sort((a, b) => a - b)
    player.bull = 0
  }
  piles = [popCard()]

  broadcastDetailStatus({
    state: STATE.BROADCAST_GAME_START,
  })
}

let fetch = data => {
  if (players[data.id] === undefined) return STATE.USER_NOT_EXIST

  return {
    state: STATE.FETCH_SUCCESS,
    player: players[data.id],
  }
}

let action = data => {
  let player = players[data.id]

  if (players[data.id] === undefined) return STATE.USER_NOT_EXIST
  if (!started) return STATE.ACT_FAIL_GAME_NOT_START
  if (data.id != playerIds[turn]) return STATE.ACT_FAIL_NOT_TURN
  if (data.data.length > Math.max(1, player.bull))
    return STATE.ACT_FAIL_PILE_EXCEED

  for (let stack of data.data) {
    let pile = piles[stack.pileNo]
    let { cards } = stack

    if (!pile) return STATE.ACT_FAIL_PILE_NOT_EXIST
    if (cards.length > 1 && player.bull == 0) return STATE.ACT_FAIL_CARD_EXCEED
    if (cards.some(card => !player.hand.includes(card)))
      return STATE.ACT_FAIL_CARD_NOT_EXIST
    if (cards.some(card => !canPushCard(pile, card)))
      return STATE.ACT_FAIL_CARD_CANNOT_PUSH
    if (cards.length == 0 && data.data.length > 1)
      return STATE.ACT_FAIL_PUSH_PICK_TOGETHER

    if (cards.length == 0 && pile.length >= 3 && freeBull == 0) {
      let maxBull = Math.max(
        ...Object.values(players).map(player => player.bull)
      )
      let target = playerIds[data.targetNo]
      if (!target) return STATE.ACT_FAIL_TARGET_NOT_EXIST
      if (target.bull == 0) return STATE.ACT_FAIL_TARGET_NO_BULL
      if (player.bull != maxBull && target.bull != maxBull)
        return STATE.ACT_FAIL_BOTH_NOT_MAX_BULL
    }
  }

  let pilesInc = []
  let pileDecNo = -1
  let bullDiff = 0

  for (let stack of data.data) {
    let { pileNo, cards } = stack
    let pile = piles[pileNo]

    if (cards.length) {
      for (let card of cards) player.hand.splice(player.hand.indexOf(card), 1)
      piles[pileNo] = pile.concat(cards.sort((a, b) => a - b))
      pilesInc.push({ no: pileNo, num: cards.length })
    } else {
      player.hand = player.hand.concat(pile).sort((a, b) => a - b)

      piles[pileNo] = []
      pileDecNo = pileNo

      for (let i = 0; i < 2; i++) {
        let newPile = popCard()
        if (newPile.length != 0) piles.push(newPile)
      }

      if (pile.length >= 3) {
        if (freeBull == 0) playerIds[data.targetNo].bull -= 1
        else freeBull -= 1
        player.bull += 1
        bullDiff += 1
      }
    }
  }

  turn = (turn + 1) % playerIds.length
  broadcastDetailStatus({
    diff: {
      playerNo: player.no,
      pilesInc,
      pileDecNo,
      targetNo: data.targetNo,
      bullDiff,
    },
  })
}

let finish = () => {
  started = false
  for (let player of Object.values(players)) {
    player.ready = false
    player.head += scoreOfPlayer(player)
  }

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN)
      client.send(
        JSON.stringify({
          state: STATE.BROADCAST_GAME_END,
          data: {
            started,
            freeBull,
            round,
            players: playerIds.map(id => ({
              nickname: players[id].nickname,
              head: players[id].head,
              newHead: scoreOfPlayer(players[id]),
              hand: players[id].hand,
              bull: players[id].bull,
              ready: false,
            })),
            piles,
          },
        })
      )
  })
}

let broadcastBasicStatus = () => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN)
      client.send(
        JSON.stringify({
          state: STATE.BROADCAST_GAME_BASIC,
          data: {
            started,
            players: playerIds.map(i => ({
              nickname: players[i].nickname,
              ready: players[i].ready,
              handNum: players[i].hand.length,
              bull: players[i].bull,
              head: players[i].head,
            })),
          },
        })
      )
  })
}

let broadcastDetailStatus = more => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN)
      client.send(
        JSON.stringify({
          state: STATE.BROADCAST_GAME_STATUS,
          data: {
            started,
            players: playerIds.map(id => ({
              nickname: players[id].nickname,
              ready: players[id].ready,
              head: players[id].head,
              handNum: players[id].hand?.length,
              bull: players[id].bull,
            })),
            piles: piles.map(pile => ({
              top: pile.length ? pile[pile.length - 1] : null,
              num: pile.length,
            })),
            freeBull,
            round,
            turn,
          },
          ...more,
        })
      )
  })
}

wss.on('connection', (ws, req) => {
  console.log(Date(), `${req.socket.remoteAddress}`)

  ws.send(
    JSON.stringify({
      state: STATE.CONNECT_SUCCESS,
    })
  )

  ws.on('message', msg => {
    console.log(Date(), `${msg}`)

    let data = JSON.parse(msg)
    let response = {}

    let getResponse = (func, data) => {
      let ret = func(data)
      if (typeof ret == 'number') return { state: ret }
      return ret
    }

    switch (data.operation) {
      case 'register':
        response = getResponse(register, data)
        break
      case 'login':
        response = getResponse(login, data)
        break
      case 'ready':
        response = getResponse(ready, data)
        if (
          !started &&
          playerIds.length >= MIN_PLAYER &&
          Object.values(players).every(player => player.ready)
        )
          start()
        break
      case 'logout':
        response = getResponse(logout, data)
        break
      case 'fetch':
        response = getResponse(fetch, data)
        break
      case 'action':
        response = getResponse(action, data)
        if (
          started &&
          (Object.values(players).some(player => player.hand.length == 0) ||
            piles.every(pile => pile.length == 0))
        )
          finish()
        break
      default:
        return
    }

    if (response) ws.send(JSON.stringify(response))
    if (
      data.operation == 'register' ||
      data.operation == 'ready' ||
      data.operation == 'logout'
    )
      broadcastBasicStatus()
    if (data.operation == 'login')
      if (!started) broadcastBasicStatus()
      else broadcastDetailStatus()

    if (data.operation == 'action')
      console.log(freeBull, round, turn, players, playerIds, piles)
  })
})
