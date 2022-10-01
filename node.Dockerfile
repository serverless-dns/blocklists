FROM nikolaik/python-nodejs:latest as runner
# todo: is git required?
WORKDIR /app
COPY . .
# get deps
RUN python -m pip install requests
RUN npm install aws-sdk

# run with the default entrypoint (usually, bash or sh)
CMD ["./run.sh"]
