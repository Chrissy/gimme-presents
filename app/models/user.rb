class User < ActiveRecord::Base
  serialize :lists, Array

  devise :omniauthable, :omniauth_providers => [:google_oauth2]

  def self.from_omniauth(access_token)
    data = access_token.info
    user = User.where(:email => data["email"]).first

    unless user
        user = User.create(name: data["name"],
           email: data["email"],
           image: data["image"],
           password: Devise.friendly_token[0,20]
        )
    end
    user
  end
end
