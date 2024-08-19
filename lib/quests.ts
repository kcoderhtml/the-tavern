import type { AppMentionEvent, GenericMessageEvent } from 'slack-edge'
import { slackClient, openAIClient, prisma } from '..'
import type {
    ChatCompletion,
    ChatCompletionMessageParam,
    ChatCompletionTool,
} from 'openai/resources/index.mjs'
import { parse } from 'yaml'
import clog from './Logger'

const file = await Bun.file('lib/quests.yaml').text()
const questsRaw: {
    characters: {
        [key: string]: {
            prompt: string
            image: string
        }
    }
    quests: {
        [key: string]: {
            description: string
            noshow?: boolean
            scenes: {
                [key: string]: {
                    prompt: string
                    character: string
                }
            }
        }
    }
} = parse(file)

// Parse the quests into an array of quest arrays
const quests = Object.fromEntries(
    Object.entries(questsRaw.quests).map(([name, quest]) => {
        return [
            name,
            {
                description: quest.description,
                noshow: quest.noshow,
                scenes: Object.entries(quest.scenes).map(([_, sceneData]) => {
                    return {
                        prompt: sceneData.prompt,
                        character: sceneData.character,
                    }
                }),
            },
        ]
    })
)

const characters = Object.fromEntries(
    Object.entries(questsRaw.characters).map(([name, character]) => [
        name,
        {
            name: name,
            prompt: character.prompt,
            image: character.image,
        },
    ])
)

const tools: ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'list_quests',
            description: 'Lists the quests available to the user',
        },
    },
    {
        type: 'function',
        function: {
            name: 'choose_quest',
            description:
                'start quest for the user on the next turn; make sure to check list_quests to make sure its in the correct format',
            parameters: {
                type: 'object',
                properties: {
                    quest: {
                        type: 'string',
                    },
                },
                required: ['quest'],
            },
        },
    },
]

export async function respond(
    event: AppMentionEvent | GenericMessageEvent,
    quest: string,
    scene: number,
    threadID: string,
    extraMessage?: boolean
) {
    const currentScene = quests[quest].scenes[scene]

    const initalMesssage = await slackClient.chat.postMessage({
        thread_ts: event?.ts,
        channel: event.channel,
        icon_url: characters[currentScene.character].image,
        username: currentScene.character,
        text: 'thinking...',
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: 'thinking... :spinning-parrot:',
                },
            },
        ],
    })

    let messages: ChatCompletionMessageParam[] = []

    if (event.thread_ts != undefined) {
        // get the contents of the thread
        const threadContents = await slackClient.conversations.replies({
            channel: event.channel,
            ts: event.thread_ts,
        })

        for (const message of threadContents.messages!) {
            // ignore the last message
            if (message.ts == initalMesssage.ts) continue

            if (message.user == event.user) {
                messages.push({
                    role: 'user',
                    content: message.text!,
                    name: message.user,
                })
            } else if ((message.bot_id = process.env.BOT_ID)) {
                messages.push({
                    role: 'assistant',
                    content: message.text!,
                    name: message.bot_profile?.name?.replaceAll(' ', '_'),
                })
            }
        }
    } else {
        messages.push({
            role: 'user',
            content: 'hi! what quest are there for me to do?',
        })
    }

    if (extraMessage)
        messages.push({
            role: 'user',
            content: 'hi! can you introduce your self?',
            name: event.user!,
        })

    const response = await toolWrapper(
        currentScene,
        event.user!,
        messages,
        threadID
    )

    await slackClient.chat.update({
        ts: initalMesssage.ts!,
        channel: initalMesssage.channel!,
        text: response.message!,
        blocks: [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: response.message!,
                },
            },
        ],
    })

    console.log(response)

    if (response.extraMessage != undefined)
        await respond(event, response.extraMessage, 0, threadID, true)
}

async function toolWrapper(
    currentScene: { prompt: string; character: string },
    userID: string,
    messages: ChatCompletionMessageParam[],
    threadID: string
) {
    messages.push(
        {
            role: 'system',
            content: currentScene.prompt,
        },
        {
            role: 'system',
            content: `${
                characters[currentScene.character]
            } Answer in no more than a paragraph. The players's name is <@${userID}>; refer to them by it.`,
        }
    )

    const completion = await openAIClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 500,
        tools,
    })

    return toolHandlerRecursive(completion, messages, threadID)
}

async function toolHandlerRecursive(
    completion: ChatCompletion,
    messages: ChatCompletionMessageParam[],
    threadID: string,
    extraMessage?: string
) {
    if (completion.choices[0].message.tool_calls?.length! > 0) {
        messages.push(completion.choices[0].message)
        for (const toolCall of completion.choices[0].message.tool_calls!) {
            switch (toolCall.function.name) {
                case 'list_quests': {
                    clog('listing quests', 'info')
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify(
                            Object.entries(quests)
                                .filter(([_, quest]) => !quest.noshow)
                                .map(([name, quest]) => ({
                                    name,
                                    description: quest.description,
                                }))
                        ),
                        tool_call_id: toolCall.id,
                    })
                    break
                }
                case 'choose_quest': {
                    const args = JSON.parse(toolCall.function.arguments)
                    clog('choosing quest ' + args.quest, 'info')
                    // check if that quest exists
                    if (quests[args.quest] == undefined) {
                        messages.push({
                            role: 'tool',
                            content: `Quest ${args.quest} does not exist; please check list quests for proper formating`,
                            tool_call_id: toolCall.id,
                        })
                        break
                    }
                    await prisma.threads.update({
                        where: { id: threadID },
                        data: {
                            quest: args.quest,
                            scene: 0,
                        },
                    })
                    messages.push({
                        role: 'tool',
                        content: `switched quest`,
                        tool_call_id: toolCall.id,
                    })
                    extraMessage = args.quest
                }
            }
        }

        const newCompletion = await openAIClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messages,
            tools,
            max_tokens: 500,
        })

        return await toolHandlerRecursive(
            newCompletion,
            messages,
            threadID,
            extraMessage
        )
    } else {
        return {
            message: completion.choices[0].message.content,
            extraMessage,
        }
    }
}
