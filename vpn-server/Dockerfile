FROM node:22-alpine
RUN apk add --no-cache wireguard-tools iproute2 iptables
WORKDIR /app
COPY package.json plans.mjs server.mjs entrypoint.sh ./
RUN chmod 0755 /app/entrypoint.sh
ENV PORT=8790 DATA_DIR=/data WG_INTERFACE=wg0 WG_ADDRESS=10.77.0.1/16 WG_PORT=51820
EXPOSE 8790 51820/udp
HEALTHCHECK --interval=20s --timeout=5s --retries=5 CMD node -e "fetch('http://127.0.0.1:8790/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/entrypoint.sh"]
