import json

def update_shots(prompts_map):
    with open("story_analysis.json", "r") as f:
        data = json.load(f)
    
    for shot in data["scenes"][0]["shots"]:
        shot_num = shot["shotNumber"]
        if shot_num in prompts_map:
            shot.update(prompts_map[shot_num])
            
    with open("story_analysis.json", "w") as f:
        json.dump(data, f, indent=2)

if __name__ == "__main__":
    # Batch 1: Scenes 1-5
    batch_1 = {
        1: {
            "composition": "wide_establishing",
            "actionPrompt": "A man in a dark jacket walks away from the camera through a grand, dimly lit hallway with large pillars towards a reception desk.",
            "startFramePrompt": "Wide shot of a man in a dark jacket walking down a grand hallway with pillars and warm lamps on a desk in the distance.",
            "endFramePrompt": "Same wide shot, the man is closer to the reception desk in the grand hallway."
        },
        2: {
            "composition": "medium_shot",
            "actionPrompt": "A man in a security uniform sits down at a desk in a dark room filled with many glowing security monitors.",
            "startFramePrompt": "Medium shot of a security guard in a light-colored shirt sitting down in a dark room with a wall of security monitors.",
            "endFramePrompt": "Same medium shot, the security guard is seated and looking at the monitors."
        },
        3: {
            "composition": "insert_cutaway",
            "actionPrompt": "A hand reaches into a brown paper bag and pulls out a sandwich wrapped in a white paper towel.",
            "startFramePrompt": "Close-up of a hand reaching into a brown paper bag.",
            "endFramePrompt": "Same close-up, the hand is holding a wrapped sandwich pulled from the bag."
        },
        4: {
            "composition": "close_up",
            "actionPrompt": "A man in a security uniform looks down at a sandwich he is holding with a focused expression.",
            "startFramePrompt": "Close-up of a security guard in a light green uniform looking down at a sandwich in his hand.",
            "endFramePrompt": "Same close-up, the security guard continues to look at the sandwich, his expression neutral."
        },
        5: {
            "composition": "wide_establishing",
            "actionPrompt": "A person walks down a long, dark, narrow corridor, shining a bright flashlight beam ahead.",
            "startFramePrompt": "Wide shot of a dark corridor with a person in the distance shining a flashlight towards the camera.",
            "endFramePrompt": "Same wide shot, the flashlight beam has moved slightly as the person continues down the corridor."
        }
    }
    update_shots(batch_1)

    # Batch 2: Scenes 6-10
    batch_2 = {
        6: {
            "composition": "close_up",
            "actionPrompt": "A close-up of the security guard's face as he looks around vigilantly in a dimly lit hallway.",
            "startFramePrompt": "Close-up of the security guard's face, eyes looking slightly to the side.",
            "endFramePrompt": "Same close-up, his gaze shifts slightly as he continues to scan the area."
        },
        7: {
            "composition": "wide_establishing",
            "actionPrompt": "The security guard enters the monitor room, seen from behind as he walks towards his desk.",
            "startFramePrompt": "Wide shot from the doorway of the monitor room, the security guard's silhouette in the foreground.",
            "endFramePrompt": "Same wide shot, the security guard has walked further into the room towards the monitors."
        },
        8: {
            "composition": "insert_cutaway",
            "actionPrompt": "Extreme close-up of hands holding a half-eaten sandwich in front of blurry security monitors.",
            "startFramePrompt": "Extreme close-up of hands holding a sandwich, the background is out of focus.",
            "endFramePrompt": "Same close-up, the hands shift the sandwich slightly."
        },
        9: {
            "composition": "medium_shot",
            "actionPrompt": "The security guard sits at his desk, holding his sandwich and looking contemplative.",
            "startFramePrompt": "Medium shot of the security guard in his uniform, seated and looking down at his food.",
            "endFramePrompt": "Same medium shot, he maintains his seated position with a slight change in facial expression."
        },
        10: {
            "composition": "insert_cutaway",
            "actionPrompt": "A hand reaches into the brown paper bag again and picks up a green apple.",
            "startFramePrompt": "Close-up of a hand reaching into the opening of a brown paper bag.",
            "endFramePrompt": "Same close-up, the hand is now grasping a green apple inside the bag."
        }
    }
    update_shots(batch_2)

    # Batch 3: Scenes 11-15
    batch_3 = {
        11: {
            "composition": "insert_cutaway",
            "actionPrompt": "Close-up of a hand reaching into a paper bag to retrieve a wrapped item.",
            "startFramePrompt": "Close-up of a hand entering a brown paper bag.",
            "endFramePrompt": "Same close-up, the hand is pulling out a small item wrapped in white paper."
        },
        12: {
            "composition": "close_up",
            "actionPrompt": "The security guard takes a bite of his sandwich while looking down.",
            "startFramePrompt": "Close-up of the security guard's face, sandwich near his mouth.",
            "endFramePrompt": "Same close-up, he has taken a bite and is chewing."
        },
        13: {
            "composition": "insert_cutaway",
            "actionPrompt": "A tablet on the desk plays a video showing hands preparing food.",
            "startFramePrompt": "Close-up of a tablet screen on a desk, displaying a video with a 'prime' logo.",
            "endFramePrompt": "Same close-up, the video on the tablet continues to play."
        },
        14: {
            "composition": "close_up",
            "actionPrompt": "The security guard watches the tablet intently while continuing to eat.",
            "startFramePrompt": "Close-up of the security guard's face, eyes focused on a screen off-camera.",
            "endFramePrompt": "Same close-up, he continues watching with a steady gaze."
        },
        15: {
            "composition": "medium_shot",
            "actionPrompt": "The security guard reaches across his desk towards a laptop while surrounded by monitors.",
            "startFramePrompt": "Medium shot of the security guard at his desk, beginning to reach for a device.",
            "endFramePrompt": "Same medium shot, his hand is extended further towards a laptop."
        }
    }
    update_shots(batch_3)

    # Batch 4: Scenes 16-20
    batch_4 = {
        16: {
            "composition": "insert_cutaway",
            "actionPrompt": "A laptop screen displays an online shopping page for a 'kitchen set' with a grill pan and knives.",
            "startFramePrompt": "Close-up of a laptop screen showing an Amazon Prime search results page for kitchenware.",
            "endFramePrompt": "Same close-up, the screen remains static on the shopping page."
        },
        17: {
            "composition": "close_up",
            "actionPrompt": "The security guard looks at the laptop screen with an expression of interest and curiosity.",
            "startFramePrompt": "Close-up of the security guard's face, illuminated by the light of the laptop screen.",
            "endFramePrompt": "Same close-up, his eyes move as if reading the screen, a slight smile forming."
        },
        18: {
            "composition": "wide_establishing",
            "actionPrompt": "The security guard stands in a brightly lit kitchen, unpacking cardboard shipping boxes on a table.",
            "startFramePrompt": "Wide shot of a kitchen where the security guard is busy with several packages on a table.",
            "endFramePrompt": "Same wide shot, he has opened one of the boxes and is looking inside."
        },
        19: {
            "composition": "medium_shot",
            "actionPrompt": "The security guard holds a new salt and pepper grinder set, inspecting it closely in his kitchen.",
            "startFramePrompt": "Medium shot of the security guard holding a black grinder, looking at it with satisfaction.",
            "endFramePrompt": "Same medium shot, he turns the grinder in his hands to examine it from different angles."
        },
        20: {
            "composition": "insert_cutaway",
            "actionPrompt": "A large kitchen knife is carefully placed onto a decorative patterned cloth on a table.",
            "startFramePrompt": "Close-up of a table with a patterned cloth, a knife lying flat on it.",
            "endFramePrompt": "Same close-up, a hand enters the frame and adjusts the position of the knife slightly."
        }
    }
    update_shots(batch_4)

    # Batch 5: Scenes 21-25
    batch_5 = {
        21: {
            "composition": "insert_cutaway",
            "actionPrompt": "Two slices of bread are being pressed down onto a hot grill pan by a pair of hands.",
            "startFramePrompt": "Top-down close-up of a grill pan on a stove, hands pressing bread onto the ridges.",
            "endFramePrompt": "Same close-up, the bread is being toasted, with steam or smoke beginning to rise."
        },
        22: {
            "composition": "medium_shot",
            "actionPrompt": "A gourmet sandwich with sliced meat and fresh greens is being assembled on a wooden cutting board.",
            "startFramePrompt": "Medium shot of a sandwich on a wooden board, a hand holding the top slice of bread above it.",
            "endFramePrompt": "Same medium shot, the hand places the top slice onto the sandwich, completing it."
        },
        23: {
            "composition": "insert_cutaway",
            "actionPrompt": "A hand holds a piece of a gourmet sandwich, revealing the layers of meat and vegetables inside.",
            "startFramePrompt": "Close-up of a hand holding a half-sandwich, the cross-section of fillings is visible.",
            "endFramePrompt": "Same close-up, the hand moves the sandwich slightly as if preparing for a bite."
        },
        24: {
            "composition": "medium_shot",
            "actionPrompt": "The security guard eats his sandwich while another guard in a similar uniform walks past in the background.",
            "startFramePrompt": "Medium shot of the security guard eating, with a doorway visible behind him.",
            "endFramePrompt": "Same medium shot, the second security guard is now walking through the doorway in the background."
        },
        25: {
            "composition": "close_up",
            "actionPrompt": "The security guard suddenly stops eating and turns his head to look at something off-camera.",
            "startFramePrompt": "Close-up of the security guard's face, he has a bit of food in his mouth and looks sideways.",
            "endFramePrompt": "Same close-up, his head is turned further, his expression shifting to one of surprise."
        }
    }
    update_shots(batch_5)

    # Batch 6: Scenes 26-30
    batch_6 = {
        26: {
            "composition": "over_the_shoulder",
            "actionPrompt": "Over-the-shoulder shot of the first security guard as a second guard (name tag 'SHIELDS') talks to him about his sandwich.",
            "startFramePrompt": "Over-the-shoulder shot from behind the first guard, focusing on the second guard standing and looking down.",
            "endFramePrompt": "Same over-the-shoulder shot, the second guard gestures slightly as he speaks."
        },
        27: {
            "composition": "wide_establishing",
            "actionPrompt": "Both security guards are in the monitor room; the first guard sits while the second one stands and eats a sandwich.",
            "startFramePrompt": "Wide shot of the security monitor room with both guards interacting.",
            "endFramePrompt": "Same wide shot, the second guard takes a bite of his sandwich."
        },
        28: {
            "composition": "close_up",
            "actionPrompt": "The first security guard looks slightly annoyed as he is interrupted during his meal.",
            "startFramePrompt": "Close-up of the first security guard's face, looking up towards the second guard.",
            "endFramePrompt": "Same close-up, his expression remains skeptical as he listens."
        },
        29: {
            "composition": "close_up",
            "actionPrompt": "The second security guard eats his sandwich and looks at his colleague with a nonchalant expression.",
            "startFramePrompt": "Close-up of the second security guard's face as he chews his food.",
            "endFramePrompt": "Same close-up, he gives a slight nod while looking at the first guard."
        },
        30: {
            "composition": "close_up",
            "actionPrompt": "The first security guard turns his attention back to the security monitors, dismissing the conversation.",
            "startFramePrompt": "Close-up of the first security guard's face as he begins to turn away.",
            "endFramePrompt": "Same close-up, he is now looking directly ahead at the screens, his back to the camera."
        }
    }
    update_shots(batch_6)

    # Batch 7: Scenes 31-35
    batch_7 = {
        31: {
            "composition": "insert_cutaway",
            "actionPrompt": "A laptop screen shows an Amazon Prime search for 'cookbooks' with various recipe book covers visible.",
            "startFramePrompt": "Close-up of a laptop screen displaying online shopping results for cookbooks.",
            "endFramePrompt": "Same close-up, the screen is static on the cookbook results."
        },
        32: {
            "composition": "insert_cutaway",
            "actionPrompt": "Hands stack several new cookbooks on a table, including one titled 'Spice Recipes'.",
            "startFramePrompt": "Close-up of hands placing a cookbook on top of another on a kitchen table.",
            "endFramePrompt": "Same close-up, the stack of three cookbooks is neatly arranged."
        },
        33: {
            "composition": "insert_cutaway",
            "actionPrompt": "A gas stove burner is ignited, with a ring of blue flames appearing instantly.",
            "startFramePrompt": "Extreme close-up of a gas stove burner before it is lit.",
            "endFramePrompt": "Same extreme close-up, the burner is now lit with vibrant blue flames."
        },
        34: {
            "composition": "wide_establishing",
            "actionPrompt": "In a blue-tiled kitchen, the security guard, wearing an apron, tastes food from a wooden spoon while cooking at the stove.",
            "startFramePrompt": "Wide shot of the security guard in his kitchen, standing by the stove and bringing a spoon to his mouth.",
            "endFramePrompt": "Same wide shot, he has tasted the food and looks thoughtful as he continues to cook."
        },
        35: {
            "composition": "close_up",
            "actionPrompt": "The security guard carefully tastes his cooking, his expression focused and analytical.",
            "startFramePrompt": "Close-up of the security guard's face as he sips from a wooden spoon.",
            "endFramePrompt": "Same close-up, he lowers the spoon, a look of satisfied concentration on his face."
        }
    }
    update_shots(batch_7)

    # Batch 8: Scenes 36-40
    batch_8 = {
        36: {
            "composition": "wide_establishing",
            "actionPrompt": "A bright flashlight beam cuts through the darkness of a grand hallway, scanning the area.",
            "startFramePrompt": "Wide shot of a dark hallway with a single beam of light projecting from the right.",
            "endFramePrompt": "Same wide shot, the light beam has moved significantly, illuminating a different part of the hallway."
        },
        37: {
            "composition": "wide_establishing",
            "actionPrompt": "The flashlight beam intensifies and points directly toward the camera in the dark hallway.",
            "startFramePrompt": "Wide shot of the dark hallway with the flashlight beam creating a bright lens flare.",
            "endFramePrompt": "Same wide shot, the light beam shifts slightly, maintaining its intensity."
        },
        38: {
            "composition": "close_up",
            "actionPrompt": "The security guard looks alert and slightly concerned while watching the security monitors.",
            "startFramePrompt": "Close-up of the security guard's face, his eyes wide and focused on the screens.",
            "endFramePrompt": "Same close-up, he leans forward slightly, his expression becoming more serious."
        },
        39: {
            "composition": "wide_establishing",
            "actionPrompt": "Thick white smoke billows from the stove in the kitchen as the security guard tries to manage a small fire.",
            "startFramePrompt": "Wide shot of the kitchen with smoke rising from the stove area and the guard reacting.",
            "endFramePrompt": "Same wide shot, the smoke has filled more of the room as he continues to move around the stove."
        },
        40: {
            "composition": "insert_cutaway",
            "actionPrompt": "A hand uses a small knife to slice through the blue shipping tape on a cardboard box.",
            "startFramePrompt": "Close-up of a cardboard box with blue tape, a knife edge just touching the tape.",
            "endFramePrompt": "Same close-up, the knife has cut through the tape and the hand is moving away."
        }
    }
    update_shots(batch_8)

    # Batch 9: Scenes 41-45
    batch_9 = {
        41: {
            "composition": "insert_cutaway",
            "actionPrompt": "Hands skillfully chop fresh green herbs on a wooden cutting board with a large knife.",
            "startFramePrompt": "Close-up of hands and a knife poised over a pile of herbs on a wooden board.",
            "endFramePrompt": "Same close-up, the herbs are now finely chopped."
        },
        42: {
            "composition": "pov",
            "actionPrompt": "POV shot from inside an oven as the security guard, wearing mitts, pulls out a tray of golden-brown food.",
            "startFramePrompt": "POV shot from the back of an oven, looking out at the security guard reaching in.",
            "endFramePrompt": "Same POV shot, the tray is being pulled forward and out of the oven."
        },
        43: {
            "composition": "insert_cutaway",
            "actionPrompt": "Food is being sautéed in a dark frying pan on a gas stove, with steam rising.",
            "startFramePrompt": "Close-up of a pan on a stove, the contents beginning to sizzle.",
            "endFramePrompt": "Same close-up, the food has been tossed and is now more evenly distributed in the pan."
        },
        44: {
            "composition": "insert_cutaway",
            "actionPrompt": "A hand squeezes a half-lemon, with juice spraying and dripping down.",
            "startFramePrompt": "Close-up of a hand holding a lemon half over an unseen dish.",
            "endFramePrompt": "Same close-up, the hand has squeezed the lemon, and juice is flowing out."
        },
        45: {
            "composition": "insert_cutaway",
            "actionPrompt": "A close-up of the lemon being squeezed further, showing the texture of the fruit and the juice.",
            "startFramePrompt": "Extreme close-up of the lemon as it is being compressed by a hand.",
            "endFramePrompt": "Same extreme close-up, the squeezing action continues with more juice visible."
        }
    }
    update_shots(batch_9)

    # Batch 10: Scenes 46-50
    batch_10 = {
        46: {
            "composition": "close_up",
            "actionPrompt": "The security guard wipes sweat from his forehead with his arm, looking exhausted but determined.",
            "startFramePrompt": "Low-angle close-up of the security guard's face as he begins to raise his arm.",
            "endFramePrompt": "Same close-up, he is now wiping his brow with his forearm."
        },
        47: {
            "composition": "wide_establishing",
            "actionPrompt": "A train sits at a station platform at night, with city lights visible in the distance.",
            "startFramePrompt": "Wide establishing shot of a subway station platform with a train stopped at the tracks.",
            "endFramePrompt": "Same wide shot, the train remains stationary at the platform."
        },
        48: {
            "composition": "insert_cutaway",
            "actionPrompt": "A smartphone screen shows an Amazon Prime video titled 'James May: Oh Cook' featuring a cooking demonstration.",
            "startFramePrompt": "Close-up of a hand holding a smartphone displaying a video player interface.",
            "endFramePrompt": "Same close-up, the video on the phone screen continues to play."
        },
        49: {
            "composition": "medium_shot",
            "actionPrompt": "The security guard, now in his dark uniform jacket, sits on a subway station bench and checks his phone.",
            "startFramePrompt": "Medium shot of the guard sitting on a blue bench in a dimly lit station, looking down at his phone.",
            "endFramePrompt": "Same medium shot, he looks up slightly as if checking for his train."
        },
        50: {
            "composition": "insert_cutaway",
            "actionPrompt": "A metal whisk rapidly beats a mixture of yellow eggs in a clear glass bowl.",
            "startFramePrompt": "Close-up of a glass bowl with eggs, a whisk just starting to move.",
            "endFramePrompt": "Same close-up, the eggs are now being vigorously whisked into a frothy mixture."
        }
    }
    update_shots(batch_10)

    # Batch 11: Scenes 51-57
    batch_11 = {
        51: {
            "composition": "insert_cutaway",
            "actionPrompt": "Powdered sugar is sifted over a beautifully layered pastry topped with fresh raspberries.",
            "startFramePrompt": "Close-up of a mille-feuille pastry, sugar beginning to fall from above.",
            "endFramePrompt": "Same close-up, the pastry is now lightly dusted with white powdered sugar."
        },
        52: {
            "composition": "close_up",
            "actionPrompt": "The second security guard smiles to himself while sitting in the monitor room.",
            "startFramePrompt": "Close-up of the second guard's face, a slight smile forming.",
            "endFramePrompt": "Same close-up, he looks pleased and relaxed."
        },
        53: {
            "composition": "close_up",
            "actionPrompt": "The first security guard beams with a wide, genuine smile, looking very satisfied.",
            "startFramePrompt": "Close-up of the first guard's face, his eyes lighting up.",
            "endFramePrompt": "Same close-up, he breaks into a full, happy grin."
        },
        54: {
            "composition": "wide_establishing",
            "actionPrompt": "The first security guard stands up and leaves the monitor room while the second guard continues to eat.",
            "startFramePrompt": "Wide shot of the monitor room as the first guard begins to stand.",
            "endFramePrompt": "Same wide shot, the first guard has walked out of frame, leaving the second guard alone."
        },
        55: {
            "composition": "wide_establishing",
            "actionPrompt": "The security guard walks down a city sidewalk at night, passing a restaurant with a glowing 'FUEGO' sign.",
            "startFramePrompt": "Wide shot of a dark street at night, the guard walking towards a restaurant.",
            "endFramePrompt": "Same wide shot, he has walked past the restaurant's entrance."
        },
        56: {
            "composition": "insert_cutaway",
            "actionPrompt": "A 'CHEF WANTED' sign is visible through the window of the FUEGO restaurant.",
            "startFramePrompt": "Close-up of a window with a white paper sign that reads 'CHEF WANTED'.",
            "endFramePrompt": "Same close-up, the sign remains centered in the frame."
        },
        57: {
            "composition": "close_up",
            "actionPrompt": "The security guard looks forward with a hopeful expression as the 'Shopping. It's on prime' logo appears.",
            "startFramePrompt": "Close-up of the guard's face against a blurred city background.",
            "endFramePrompt": "Same close-up, text overlays his face as the screen fades slightly."
        }
    }
    update_shots(batch_11)
