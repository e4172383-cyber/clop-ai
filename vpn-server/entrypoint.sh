#!/bin/sh
set -eu

mkdir -p "$DATA_DIR"
umask 077
if [ ! -s "$DATA_DIR/server.key" ]; then
  wg genkey > "$DATA_DIR/server.key"
fi
wg pubkey < "$DATA_DIR/server.key" > "$DATA_DIR/server.pub"

ip link show "$WG_INTERFACE" >/dev/null 2>&1 || ip link add dev "$WG_INTERFACE" type wireguard
ip address replace "$WG_ADDRESS" dev "$WG_INTERFACE"
wg set "$WG_INTERFACE" private-key "$DATA_DIR/server.key" listen-port "$WG_PORT"
ip link set mtu 1420 up dev "$WG_INTERFACE"

iptables -C FORWARD -i "$WG_INTERFACE" -j ACCEPT 2>/dev/null || iptables -A FORWARD -i "$WG_INTERFACE" -j ACCEPT
iptables -C FORWARD -o "$WG_INTERFACE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -A FORWARD -o "$WG_INTERFACE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -C POSTROUTING -s 10.77.0.0/16 -o eth0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.77.0.0/16 -o eth0 -j MASQUERADE

exec node /app/server.mjs
