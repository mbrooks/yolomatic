FROM yolomatic-worker-base:latest

USER root

ENV NVM_DIR=/home/yolomatic/.nvm

RUN mkdir -p "$NVM_DIR" \
  && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh -o /tmp/install-nvm.sh \
  && PROFILE=/dev/null NVM_DIR="$NVM_DIR" bash /tmp/install-nvm.sh \
  && . "$NVM_DIR/nvm.sh" \
  && nvm install 26 \
  && nvm alias default 26 \
  && node_bin_dir="$(dirname "$(nvm which default)")" \
  && ln -sf "$node_bin_dir/node" /usr/local/bin/node \
  && ln -sf "$node_bin_dir/npm" /usr/local/bin/npm \
  && ln -sf "$node_bin_dir/npx" /usr/local/bin/npx \
  && chown -R yolomatic:yolomatic "$NVM_DIR" \
  && rm -f /tmp/install-nvm.sh

USER yolomatic
